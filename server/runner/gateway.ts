import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { db } from "../core/db.js";
import {
  RUNNER_PROTOCOL_VERSION,
  parseRunnerInboundMessage,
  type PlatformRunnerMessage,
  type RunnerRpcMethod,
} from "./protocol.js";
import {
  authenticateRunnerToken,
  getRunner,
  markRunnerOffline,
  updateRunnerHello,
  type PlatformRunner,
} from "./registry.js";

type DB = Database.Database;

interface PendingRpc {
  runnerId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface BrowserTerminal {
  runnerId: string;
  socket: WebSocket;
}

function bearer(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
}

function messageText(raw: WebSocket.RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

export class RunnerGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  private readonly connections = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingRpc>();
  private readonly terminals = new Map<string, BrowserTerminal>();

  constructor(private readonly database: DB) {
    this.wss.on("connection", (socket: WebSocket, _request: IncomingMessage, runner: PlatformRunner) => {
      const previous = this.connections.get(runner.id);
      if (previous && previous !== socket) previous.close(4001, "Runner reconnected");
      // A TCP/WebSocket connection is not usable until a compatible hello for
      // this exact connection has been received.
      markRunnerOffline(this.database, runner.id);
      this.connections.set(runner.id, socket);

      socket.on("message", (raw) => this.onMessage(runner.id, messageText(raw)));
      socket.on("close", () => this.onClose(runner.id, socket));
      socket.on("error", () => {});
    });
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const runner = authenticateRunnerToken(this.database, bearer(request.headers.authorization));
    if (!runner) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit("connection", ws, request, runner);
    });
  }

  isOnline(runnerId: string): boolean {
    const runner = getRunner(this.database, runnerId);
    return this.isConnected(runnerId)
      && runner?.status === "online"
      && runner.protocol_version === RUNNER_PROTOCOL_VERSION;
  }

  isConnected(runnerId: string): boolean {
    return this.connections.get(runnerId)?.readyState === WebSocket.OPEN;
  }

  disconnectRunner(runnerId: string): void {
    this.connections.get(runnerId)?.close(4003, "Runner revoked");
  }

  async call(
    runnerId: string,
    method: RunnerRpcMethod,
    params: unknown,
    timeoutMs = 120_000,
  ): Promise<unknown> {
    const socket = this.connections.get(runnerId);
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.isOnline(runnerId)) {
      throw new Error("Runner 当前离线或协议尚未就绪");
    }
    const id = `rpc_${crypto.randomBytes(12).toString("base64url")}`;
    const request: PlatformRunnerMessage = { type: "rpc.request", id, method, params };
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Runner 操作超时：${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { runnerId, resolve, reject, timer });
      socket.send(JSON.stringify(request), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  attachBrowserTerminal(runnerId: string, runnerTaskId: number, session: string, browser: WebSocket): void {
    const runner = this.connections.get(runnerId);
    if (!runner || runner.readyState !== WebSocket.OPEN || !this.isOnline(runnerId)) {
      browser.close(1013, "Runner offline");
      return;
    }
    const channel = `term_${crypto.randomBytes(12).toString("base64url")}`;
    this.terminals.set(channel, { runnerId, socket: browser });
    this.send(runnerId, { type: "terminal.open", channel, runner_task_id: runnerTaskId, session });

    browser.on("message", (raw) => {
      const data = messageText(raw);
      if (data.startsWith("\x00resize:")) {
        const [cols, rows] = data.slice("\x00resize:".length).split("x").map(Number);
        if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
          this.send(runnerId, { type: "terminal.resize", channel, cols, rows });
        }
        return;
      }
      this.send(runnerId, { type: "terminal.input", channel, data });
    });
    browser.on("close", () => {
      this.terminals.delete(channel);
      this.send(runnerId, { type: "terminal.close", channel });
    });
  }

  private send(runnerId: string, message: PlatformRunnerMessage): void {
    const socket = this.connections.get(runnerId);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private onMessage(runnerId: string, raw: string): void {
    const message = parseRunnerInboundMessage(raw);
    if (!message) return;
    if (message.type === "runner.hello") {
      const compatible = message.protocol_version === RUNNER_PROTOCOL_VERSION;
      updateRunnerHello(this.database, runnerId, message.protocol_version, message.capabilities, compatible);
      if (!compatible) {
        this.database.prepare(
          "UPDATE platform_runners SET status='upgrade_required' WHERE id=?",
        ).run(runnerId);
      }
      return;
    }
    // Ignore every data-plane message until this connection has completed a
    // compatible hello. A valid device token alone does not negotiate v1.
    if (!this.isOnline(runnerId)) return;
    if (message.type === "rpc.result") {
      const pending = this.pending.get(message.id);
      if (!pending || pending.runnerId !== runnerId) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "Runner 操作失败"));
      return;
    }
    if (message.type === "execution.event") {
      this.database.prepare(
        "UPDATE platform_runner_executions SET status=?,runner_task_id=COALESCE(?,runner_task_id)," +
          "session=COALESCE(?,session),work_branch=COALESCE(?,work_branch)," +
          "base_commit=COALESCE(?,base_commit),head_commit=COALESCE(?,head_commit),error=?," +
          "updated_at=datetime('now') WHERE id=? AND runner_id=?",
      ).run(
        message.status,
        message.runner_task_id ?? null,
        message.session ?? null,
        message.work_branch ?? null,
        message.base_commit ?? null,
        message.head_commit ?? null,
        message.error ?? null,
        message.execution_id,
        runnerId,
      );
      return;
    }
    if (message.type === "terminal.data") {
      const terminal = this.terminals.get(message.channel);
      if (terminal?.runnerId === runnerId && terminal.socket.readyState === WebSocket.OPEN) {
        terminal.socket.send(message.data);
      }
      return;
    }
    if (message.type === "terminal.closed") {
      const terminal = this.terminals.get(message.channel);
      if (terminal?.runnerId === runnerId) {
        this.terminals.delete(message.channel);
        terminal.socket.close(message.error ? 1011 : 1000, message.error || "Terminal closed");
      }
    }
  }

  private onClose(runnerId: string, socket: WebSocket): void {
    if (this.connections.get(runnerId) !== socket) return;
    this.connections.delete(runnerId);
    markRunnerOffline(this.database, runnerId);
    for (const [id, pending] of this.pending) {
      if (pending.runnerId !== runnerId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error("Runner 连接已断开"));
      this.pending.delete(id);
    }
    for (const [channel, terminal] of this.terminals) {
      if (terminal.runnerId !== runnerId) continue;
      terminal.socket.close(1013, "Runner disconnected");
      this.terminals.delete(channel);
    }
  }
}

export const runnerGateway = new RunnerGateway(db);
