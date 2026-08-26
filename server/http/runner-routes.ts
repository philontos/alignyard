import os from "node:os";
import type Database from "better-sqlite3";
import type { Express } from "express";
import { authenticatedUser } from "../auth/auth.js";
import { runnerGateway } from "../runner/gateway.js";
import {
  claimRunnerPairing,
  createRunnerPairing,
  listUserRunners,
  revokeRunner,
} from "../runner/registry.js";

type DB = Database.Database;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Routes used before the Runner owns a credential. They intentionally do not
 * sit behind browser authentication; the short-lived pairing code is the only
 * authority and can be claimed once. */
export function registerRunnerPublicRoutes(app: Express, db: DB) {
  app.post("/api/runner/claim", (req, res) => {
    const code = text(req.body?.code).toUpperCase();
    const name = text(req.body?.name, `${os.hostname()} Runner`);
    const platform = text(req.body?.os);
    const arch = text(req.body?.arch);
    if (!code || !platform || !arch) {
      return res.status(400).json({ error: "配对码、操作系统和架构不能为空" });
    }
    const claimed = claimRunnerPairing(db, code, { name, os: platform, arch });
    if (!claimed) return res.status(404).json({ error: "配对码无效、已使用或已过期" });
    res.status(201).json({
      runner: claimed.runner,
      token: claimed.token,
      protocol_version: 1,
    });
  });
}

export function registerRunnerRoutes(app: Express, db: DB) {
  app.get("/api/runners", (req, res) => {
    const user = authenticatedUser(req);
    res.json(listUserRunners(db, user.id).map((runner) => ({
      ...runner,
      status: runnerGateway.isConnected(runner.id) ? runner.status : "offline",
    })));
  });

  app.post("/api/runners/pairings", (req, res) => {
    const user = authenticatedUser(req);
    res.status(201).json(createRunnerPairing(db, user.id));
  });

  app.delete("/api/runners/:id", (req, res) => {
    const user = authenticatedUser(req);
    if (!revokeRunner(db, req.params.id, user.id)) {
      return res.status(404).json({ error: "Runner 不存在" });
    }
    runnerGateway.disconnectRunner(req.params.id);
    res.json({ ok: true });
  });
}
