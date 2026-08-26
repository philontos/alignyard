import os from "node:os";
import { WebSocket } from "ws";
import pty from "node-pty";
import { spawnPty } from "../session/pty.js";
import { TMUX_BIN } from "../session/binaries.js";
import { runnerCapabilities } from "./capabilities.js";
import { runnerWebSocketUrl, type RunnerConfig } from "./config.js";
import { executeRunnerRpc } from "./operations.js";
import { db } from "../core/db.js";
import { getOwnedTask } from "../core/ownership.js";
import {
  RUNNER_PROTOCOL_VERSION,
  isRunnerRpcMethod,
  parsePlatformRunnerMessage,
  type PlatformRunnerMessage,
  type RunnerExecutionEvent,
} from "./protocol.js";

interface LocalTerminal { term: pty.IPty }

function send(socket: WebSocket, value: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function eventFromResult(params: any, result: any): RunnerExecutionEvent | null {
  if (!params?.execution_id || !result?.runner_task_id) return null;
  return {
    type: "execution.event",
    execution_id: params.execution_id,
    status: result.status === "cleaned" ? "cleaned" : result.status === "stopped" ? "stopped" : "running",
    runner_task_id: result.runner_task_id,
    session: result.session,
    work_branch: result.work_branch,
    base_commit: result.base_commit,
    head_commit: result.head_commit,
  };
}

export class RunnerClient {
  private stopped = false;
  private socket: WebSocket | null = null;
  private readonly terminals = new Map<string, LocalTerminal>();

  constructor(private readonly config: RunnerConfig) {}

  stop() {
    this.stopped = true;
    const socket = this.socket;
    if (socket?.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket?.readyState === WebSocket.OPEN) socket.close(1000, "Runner stopping");
    for (const { term } of this.terminals.values()) term.kill();
  }

  async run(): Promise<void> {
    let delay = 1_000;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        delay = 1_000;
      } catch (error: any) {
        process.stderr.write(`Runner 连接失败：${String(error?.message || error)}\n`);
      }
      if (this.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private async connectOnce(): Promise<void> {
    const socket = new WebSocket(runnerWebSocketUrl(this.config.platform_url), {
      headers: { authorization: `Bearer ${this.config.token}` },
      maxPayload: 2 * 1024 * 1024,
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    process.stdout.write(`Runner ${this.config.name} 已连接 ${this.config.platform_url}\n`);
    const hello = async () => send(socket, {
      type: "runner.hello",
      protocol_version: RUNNER_PROTOCOL_VERSION,
      capabilities: await runnerCapabilities(),
    });
    await hello();
    const heartbeat = setInterval(() => void hello(), 20_000);
    heartbeat.unref();

    socket.on("message", (raw) => {
      const message = parsePlatformRunnerMessage(raw.toString());
      if (message) void this.handleMessage(socket, message);
    });
    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.once("error", resolve);
    });
    clearInterval(heartbeat);
    if (this.socket === socket) this.socket = null;
    for (const { term } of this.terminals.values()) term.kill();
    this.terminals.clear();
  }

  private async handleMessage(socket: WebSocket, message: PlatformRunnerMessage): Promise<void> {
    if (message.type === "rpc.request") {
      if (!isRunnerRpcMethod(message.method)) {
        send(socket, { type: "rpc.result", id: message.id, ok: false, error: "不支持的 Runner 操作" });
        return;
      }
      try {
        const result = await executeRunnerRpc(message.method, message.params);
        send(socket, { type: "rpc.result", id: message.id, ok: true, result });
        const event = eventFromResult(message.params, result);
        if (event) send(socket, event);
      } catch (error: any) {
        const detail = String(error?.message || error);
        send(socket, { type: "rpc.result", id: message.id, ok: false, error: detail });
        const executionId = (message.params as any)?.execution_id;
        if (executionId) send(socket, {
          type: "execution.event",
          execution_id: executionId,
          status: "failed",
          error: detail,
        });
      }
      return;
    }
    if (message.type === "terminal.open") {
      try {
        const task = getOwnedTask(db, message.runner_task_id);
        if (!task || task.session !== message.session) throw new Error("Runner 终端目标不属于指定 Task");
        const term = spawnPty(TMUX_BIN, ["attach", "-t", message.session], {
          name: "xterm-256color",
          cols: 120,
          rows: 32,
          cwd: os.homedir(),
          env: process.env as Record<string, string>,
        });
        this.terminals.set(message.channel, { term });
        term.onData((data) => send(socket, { type: "terminal.data", channel: message.channel, data }));
        term.onExit(() => {
          this.terminals.delete(message.channel);
          send(socket, { type: "terminal.closed", channel: message.channel });
        });
        send(socket, { type: "terminal.opened", channel: message.channel });
      } catch (error: any) {
        send(socket, { type: "terminal.closed", channel: message.channel, error: String(error?.message || error) });
      }
      return;
    }
    const terminal = this.terminals.get(message.channel);
    if (!terminal) return;
    if (message.type === "terminal.input") terminal.term.write(message.data);
    if (message.type === "terminal.resize") terminal.term.resize(message.cols, message.rows);
    if (message.type === "terminal.close") {
      terminal.term.kill();
      this.terminals.delete(message.channel);
    }
  }
}
