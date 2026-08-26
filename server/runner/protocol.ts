export const RUNNER_PROTOCOL_VERSION = 1;

export const RUNNER_RPC_METHODS = [
  "capabilities.refresh",
  "repository.branches",
  "repository.refresh-protocol",
  "execution.start",
  "execution.status",
  "execution.resume",
  "execution.stop",
  "execution.cleanup",
  "execution.message",
  "execution.prepare-review",
  "change-request.create",
  "change-request.refresh",
  "change-request.merge",
  "change-request.close",
] as const;

export type RunnerRpcMethod = typeof RUNNER_RPC_METHODS[number];

export interface RunnerCapabilities {
  git: boolean;
  tmux: boolean;
  ssh: boolean;
  agents: {
    codex: boolean;
    claude: boolean;
    kimi: boolean;
  };
  forge: {
    gh: boolean;
    glab: boolean;
  };
}

export interface RunnerHelloMessage {
  type: "runner.hello";
  protocol_version: number;
  capabilities: RunnerCapabilities;
}

export interface RunnerRpcRequest {
  type: "rpc.request";
  id: string;
  method: RunnerRpcMethod;
  params: unknown;
}

export interface RunnerRpcResult {
  type: "rpc.result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface RunnerExecutionEvent {
  type: "execution.event";
  execution_id: string;
  status: "queued" | "starting" | "running" | "waiting" | "stopped" | "failed" | "cleaned";
  runner_task_id?: number;
  session?: string;
  work_branch?: string;
  base_commit?: string;
  head_commit?: string;
  error?: string;
}

export interface RunnerTerminalOpened {
  type: "terminal.opened";
  channel: string;
}

export interface RunnerTerminalData {
  type: "terminal.data";
  channel: string;
  data: string;
}

export interface RunnerTerminalClosed {
  type: "terminal.closed";
  channel: string;
  error?: string;
}

export type RunnerInboundMessage =
  | RunnerHelloMessage
  | RunnerRpcResult
  | RunnerExecutionEvent
  | RunnerTerminalOpened
  | RunnerTerminalData
  | RunnerTerminalClosed;

export type PlatformRunnerMessage =
  | RunnerRpcRequest
  | { type: "terminal.open"; channel: string; runner_task_id: number; session: string }
  | { type: "terminal.input"; channel: string; data: string }
  | { type: "terminal.resize"; channel: string; cols: number; rows: number }
  | { type: "terminal.close"; channel: string };

export function isRunnerRpcMethod(value: unknown): value is RunnerRpcMethod {
  return typeof value === "string" && (RUNNER_RPC_METHODS as readonly string[]).includes(value);
}

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max = 8_192): value is string {
  return typeof value === "string" && value.length <= max;
}

function capabilities(value: unknown): value is RunnerCapabilities {
  if (!record(value) || !record(value.agents) || !record(value.forge)) return false;
  return [value.git, value.tmux, value.ssh, value.agents.codex, value.agents.claude,
    value.agents.kimi, value.forge.gh, value.forge.glab].every((item) => typeof item === "boolean");
}

export function parseRunnerInboundMessage(raw: string): RunnerInboundMessage | null {
  let value: any;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!record(value) || typeof value.type !== "string") return null;
  if (value.type === "runner.hello") {
    return Number.isInteger(value.protocol_version) && capabilities(value.capabilities)
      ? value as RunnerHelloMessage
      : null;
  }
  if (value.type === "rpc.result") {
    return text(value.id, 128) && typeof value.ok === "boolean"
      && (value.error == null || text(value.error)) ? value as RunnerRpcResult : null;
  }
  if (value.type === "execution.event") {
    const statuses: RunnerExecutionEvent["status"][] = [
      "queued", "starting", "running", "waiting", "stopped", "failed", "cleaned",
    ];
    const optionalText = [value.session, value.work_branch, value.base_commit, value.head_commit, value.error]
      .every((item) => item == null || text(item));
    return text(value.execution_id, 128) && statuses.includes(value.status)
      && (value.runner_task_id == null || (Number.isInteger(value.runner_task_id) && value.runner_task_id > 0))
      && optionalText ? value as RunnerExecutionEvent : null;
  }
  if (value.type === "terminal.opened") {
    return text(value.channel, 128) ? value as RunnerTerminalOpened : null;
  }
  if (value.type === "terminal.data") {
    return text(value.channel, 128) && text(value.data, 2 * 1024 * 1024) ? value as RunnerTerminalData : null;
  }
  if (value.type === "terminal.closed") {
    return text(value.channel, 128) && (value.error == null || text(value.error))
      ? value as RunnerTerminalClosed : null;
  }
  return null;
}

export function parsePlatformRunnerMessage(raw: string): PlatformRunnerMessage | null {
  let value: any;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!record(value) || typeof value.type !== "string") return null;
  if (value.type === "rpc.request") {
    return text(value.id, 128) && isRunnerRpcMethod(value.method) ? value as RunnerRpcRequest : null;
  }
  if (!text(value.channel, 128)) return null;
  if (value.type === "terminal.open") {
    return Number.isInteger(value.runner_task_id) && value.runner_task_id > 0 && text(value.session, 256)
      ? value as PlatformRunnerMessage : null;
  }
  if (value.type === "terminal.input") {
    return text(value.data, 2 * 1024 * 1024) ? value as PlatformRunnerMessage : null;
  }
  if (value.type === "terminal.resize") {
    return Number.isInteger(value.cols) && Number.isInteger(value.rows)
      && value.cols > 0 && value.cols <= 1_000 && value.rows > 0 && value.rows <= 1_000
      ? value as PlatformRunnerMessage : null;
  }
  return value.type === "terminal.close" ? value as PlatformRunnerMessage : null;
}
