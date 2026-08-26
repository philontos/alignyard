import type Database from "better-sqlite3";
import type { Express, Request } from "express";
import {
  SESSION_COOKIE,
  authMode,
  authenticateHeaders,
  createPlatformSession,
  googleConfigurationError,
  googleEmailAllowed,
  googleClientId,
  publicPlatformUser,
  revokePlatformSession,
  parseCookie,
  sessionCookieOptions,
  upsertPlatformUser,
  verifyGoogleCredential,
} from "../auth/auth.js";

type DB = Database.Database;

function requestOrigin(req: Request): string {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return `${forwarded || req.protocol}://${req.get("host")}`;
}

function validSameOrigin(req: Request): boolean {
  const origin = req.get("origin");
  if (!origin) return true;
  try { return new URL(origin).origin === requestOrigin(req); } catch { return false; }
}

export function registerAuthRoutes(app: Express, db: DB, env: NodeJS.ProcessEnv = process.env) {
  app.get("/api/auth/config", (_req, res) => {
    try {
      const mode = authMode(env);
      const clientId = googleClientId(env);
      const configurationError = googleConfigurationError(env);
      if (configurationError) return res.status(503).json({ error: configurationError });
      res.json({ mode, execution_mode: "runner", google_client_id: mode === "google" ? clientId : null });
    } catch (error: any) {
      res.status(503).json({ error: String(error?.message || error) });
    }
  });

  app.get("/api/auth/me", (req, res) => {
    try {
      const authenticated = authenticateHeaders(db, req.headers, env);
      if (!authenticated) return res.status(401).json({ error: "请先登录 Alignyard" });
      res.json(publicPlatformUser(authenticated.user));
    } catch (error: any) {
      res.status(503).json({ error: String(error?.message || error) });
    }
  });

  app.post("/api/auth/google", async (req, res) => {
    try {
      if (authMode(env) !== "google") return res.status(409).json({ error: "当前未启用 Google 登录" });
      if (!validSameOrigin(req)) return res.status(403).json({ error: "登录请求来源无效" });
      const configurationError = googleConfigurationError(env);
      if (configurationError) return res.status(503).json({ error: configurationError });
      const clientId = googleClientId(env);
      if (!clientId) return res.status(503).json({ error: "缺少 GOOGLE_CLIENT_ID" });
      const identity = await verifyGoogleCredential(String(req.body?.credential || ""), clientId);
      if (!googleEmailAllowed(identity, env)) {
        return res.status(403).json({ error: "此 Google 账号不在 Alignyard 登录名单中" });
      }
      const user = upsertPlatformUser(db, "google", identity);
      if (user.status !== "active") return res.status(403).json({ error: "此用户已停用" });
      const session = createPlatformSession(db, user.id);
      res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions(req));
      res.json(publicPlatformUser(user));
    } catch (error: any) {
      res.status(401).json({ error: `Google 登录失败：${String(error?.message || error)}` });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    revokePlatformSession(db, parseCookie(req.headers.cookie, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(req), maxAge: undefined });
    res.json({ ok: true });
  });
}
