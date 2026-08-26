import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { db } from "../core/db.js";
import { authenticateHeaders } from "../auth/auth.js";
import { runnerGateway } from "../runner/gateway.js";

const platformTerminals = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

function reject(socket: Duplex, status: string): true {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
  return true;
}

/** Handle Runner and execution-terminal upgrades; return false for unrelated paths. */
export function handlePlatformWsUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(request.url || "", "http://localhost");
  if (url.pathname === "/runner") {
    runnerGateway.handleUpgrade(request, socket, head);
    return true;
  }
  if (url.pathname !== "/pty" || !url.searchParams.get("execution")) return false;

  const authenticated = authenticateHeaders(db, request.headers);
  if (!authenticated) return reject(socket, "401 Unauthorized");
  if (authenticated.kind !== "local" && authenticated.kind !== "session") {
    return reject(socket, "403 Forbidden");
  }

  const executionId = url.searchParams.get("execution")!;
  const execution = db.prepare(
    "SELECT runner_id,runner_task_id,session,actor_user_id FROM platform_runner_executions WHERE id=?",
  ).get(executionId) as {
    runner_id: string;
    runner_task_id: number | null;
    session: string | null;
    actor_user_id: number | null;
  } | undefined;
  if (!execution?.session) return reject(socket, "404 Not Found");
  if (authenticated.kind === "session" && execution.actor_user_id !== authenticated.user.id) {
    return reject(socket, "403 Forbidden");
  }
  if (execution.runner_task_id == null) return reject(socket, "409 Conflict");

  platformTerminals.handleUpgrade(request, socket, head, (browser) => {
    runnerGateway.attachBrowserTerminal(
      execution.runner_id,
      execution.runner_task_id!,
      execution.session!,
      browser,
    );
  });
  return true;
}

export function attachPlatformWs(server: Server): void {
  server.on("upgrade", (request, socket, head) => {
    if (!handlePlatformWsUpgrade(request, socket, head)) socket.destroy();
  });
}
