import express from "express";
import path from "node:path";
import { db } from "../core/db.js";
import { ROOT, WEB_DIR } from "../core/paths.js";
import { requireAuthentication } from "../auth/auth.js";
import { registerAuthRoutes } from "../http/auth-routes.js";
import { registerRunnerPublicRoutes, registerRunnerRoutes } from "../http/runner-routes.js";
import { registerPlatformRoutes } from "../http/platform-routes.js";
import { platformRunnerBackend } from "../http/platform-runner-backend.js";

/** Cloud composition root: identity, collaboration APIs, static Web and Runner gateway. */
export function createPlatformApp(env: NodeJS.ProcessEnv = process.env) {
  const app = express();
  app.set("trust proxy", env.ALIGNYARD_TRUST_PROXY || "loopback");
  app.use(express.json({ limit: "10mb" }));
  app.get("/healthz", (_req, res) => {
    db.prepare("SELECT 1").get();
    res.json({ ok: true });
  });
  app.get("/", (_req, res) => res.sendFile(path.join(WEB_DIR, "platform.html")));
  app.use("/downloads/runner", express.static(
    env.ALIGNYARD_RUNNER_ARTIFACT_DIR?.trim() || path.join(ROOT, "dist", "runner"),
    { fallthrough: true, maxAge: "1h" },
  ));
  app.get("/index.html", (_req, res) => res.sendStatus(404));
  app.use(express.static(WEB_DIR, { index: false }));
  registerAuthRoutes(app, db, env);
  registerRunnerPublicRoutes(app, db);
  app.use("/api", requireAuthentication(db, env));
  registerRunnerRoutes(app, db);
  registerPlatformRoutes(app, platformRunnerBackend);
  return app;
}
