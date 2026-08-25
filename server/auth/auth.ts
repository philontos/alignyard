import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { NextFunction, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";

type DB = Database.Database;

export const SESSION_COOKIE = "ay_session";
const SESSION_AGE_SECONDS = 7 * 24 * 60 * 60;
const localUsers = new WeakMap<object, Map<string, PlatformUser>>();

export type AuthMode = "local" | "google";

export interface PlatformUser {
  id: number;
  provider: string;
  provider_subject: string;
  email: string | null;
  email_verified: boolean;
  name: string;
  avatar_url: string | null;
  status: "active" | "disabled";
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicPlatformUser {
  id: number;
  provider: string;
  email: string | null;
  name: string;
  avatar_url: string | null;
}

type PlatformUserRow = Omit<PlatformUser, "email_verified"> & { email_verified: number };

export interface AuthenticatedRequest extends Request {
  alignyardUser?: PlatformUser;
  alignyardAuthKind?: "local" | "session" | "service";
}

export interface GoogleIdentity {
  sub: string;
  email?: string | null;
  email_verified?: boolean;
  name?: string | null;
  picture?: string | null;
}

export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const configured = env.ALIGNYARD_AUTH_MODE?.trim().toLowerCase();
  if (configured && configured !== "local" && configured !== "google") {
    throw new Error("ALIGNYARD_AUTH_MODE 只能是 local 或 google");
  }
  return configured === "google" || (!configured && !!env.GOOGLE_CLIENT_ID?.trim()) ? "google" : "local";
}

export function googleClientId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GOOGLE_CLIENT_ID?.trim() || null;
}

export function googleEmailAllowed(
  identity: Pick<GoogleIdentity, "email" | "email_verified">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!identity.email || identity.email_verified !== true) return false;
  if (env.ALIGNYARD_AUTH_ALLOW_ANY_GOOGLE?.trim() === "1") return true;
  const allowed = new Set((env.ALIGNYARD_ALLOWED_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean));
  return allowed.has(identity.email.trim().toLowerCase());
}

export function googleConfigurationError(env: NodeJS.ProcessEnv = process.env): string | null {
  if (authMode(env) !== "google") return null;
  if (!googleClientId(env)) return "Google 登录已启用，但缺少 GOOGLE_CLIENT_ID";
  if (!env.ALIGNYARD_API_TOKEN?.trim()) return "Google 登录已启用，但缺少 ALIGNYARD_API_TOKEN";
  if (!env.ALIGNYARD_ALLOWED_EMAILS?.trim() && env.ALIGNYARD_AUTH_ALLOW_ANY_GOOGLE?.trim() !== "1") {
    return "Google 登录已启用，但缺少 ALIGNYARD_ALLOWED_EMAILS";
  }
  return null;
}

function shapeUser(row: PlatformUserRow | undefined): PlatformUser | undefined {
  return row ? { ...row, email_verified: row.email_verified === 1 } : undefined;
}

export function getPlatformUser(db: DB, id: number): PlatformUser | undefined {
  return shapeUser(db.prepare(
    "SELECT id,provider,provider_subject,email,email_verified,name,avatar_url,status," +
      "last_login_at,created_at,updated_at FROM platform_users WHERE id=?",
  ).get(id) as PlatformUserRow | undefined);
}

export function listAuthenticatedUsers(db: DB): PlatformUser[] {
  return (db.prepare(
    "SELECT id,provider,provider_subject,email,email_verified,name,avatar_url,status," +
      "last_login_at,created_at,updated_at FROM platform_users " +
      "WHERE status='active' AND provider<>'service' " +
      "ORDER BY name COLLATE NOCASE,email COLLATE NOCASE,id",
  ).all() as PlatformUserRow[]).map((row) => shapeUser(row)!);
}

export function publicPlatformUser(user: PlatformUser): PublicPlatformUser {
  return {
    id: user.id,
    provider: user.provider,
    email: user.email,
    name: user.name,
    avatar_url: user.avatar_url,
  };
}

function bindLegacyActorRows(db: DB, user: PlatformUser) {
  db.prepare(
    "UPDATE platform_repositories SET created_by_user_id=? WHERE created_by_user_id IS NULL AND created_by=?",
  ).run(user.id, user.name);
  db.prepare(
    "UPDATE platform_tasks SET owner_user_id=? WHERE owner_user_id IS NULL AND owner=?",
  ).run(user.id, user.name);
  db.prepare(
    "UPDATE platform_tasks SET current_assignee_user_id=? " +
      "WHERE current_assignee_user_id IS NULL AND current_assignee=?",
  ).run(user.id, user.name);
  db.prepare(
    "UPDATE platform_task_reviews SET reviewer_user_id=? WHERE reviewer_user_id IS NULL AND reviewer=?",
  ).run(user.id, user.name);
  db.prepare(
    "UPDATE platform_task_reviews SET submitted_by_user_id=? WHERE submitted_by_user_id IS NULL AND submitted_by=?",
  ).run(user.id, user.name);
}

export function upsertPlatformUser(db: DB, provider: string, identity: GoogleIdentity): PlatformUser {
  const subject = identity.sub?.trim();
  if (!subject) throw new Error("登录身份缺少稳定 subject");
  const email = identity.email?.trim() || null;
  const name = identity.name?.trim() || email || "Alignyard 用户";
  db.prepare(
    "INSERT INTO platform_users " +
      "(provider,provider_subject,email,email_verified,name,avatar_url,last_login_at) " +
      "VALUES (?,?,?,?,?,?,datetime('now')) " +
      "ON CONFLICT(provider,provider_subject) DO UPDATE SET " +
      "email=excluded.email,email_verified=excluded.email_verified,name=excluded.name," +
      "avatar_url=excluded.avatar_url,last_login_at=datetime('now'),updated_at=datetime('now')",
  ).run(provider, subject, email, identity.email_verified ? 1 : 0, name, identity.picture?.trim() || null);
  const row = db.prepare(
    "SELECT id,provider,provider_subject,email,email_verified,name,avatar_url,status," +
      "last_login_at,created_at,updated_at FROM platform_users WHERE provider=? AND provider_subject=?",
  ).get(provider, subject) as PlatformUserRow;
  const user = shapeUser(row)!;
  bindLegacyActorRows(db, user);
  return user;
}

export function ensureLocalUser(db: DB, env: NodeJS.ProcessEnv = process.env): PlatformUser {
  const name = env.ALIGNYARD_LOCAL_USER?.trim() || "Phil";
  const email = env.ALIGNYARD_LOCAL_EMAIL?.trim() || null;
  const subject = env.ALIGNYARD_LOCAL_SUBJECT?.trim() || "developer";
  let cache = localUsers.get(db);
  if (!cache) {
    cache = new Map();
    localUsers.set(db, cache);
  }
  const cached = cache.get(subject);
  if (cached && cached.name === name && cached.email === email) return cached;
  const user = upsertPlatformUser(db, "local", {
    sub: subject,
    name,
    email,
    email_verified: !!email,
  });
  cache.set(subject, user);
  return user;
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createPlatformSession(
  db: DB,
  userId: number,
  now = new Date(),
): { token: string; expiresAt: Date } {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_AGE_SECONDS * 1000);
  db.prepare(
    "INSERT INTO platform_sessions (token_hash,user_id,expires_at) VALUES (?,?,?)",
  ).run(tokenHash(token), userId, expiresAt.toISOString());
  db.prepare("DELETE FROM platform_sessions WHERE expires_at<=?").run(now.toISOString());
  return { token, expiresAt };
}

export function revokePlatformSession(db: DB, token: string | null | undefined): void {
  if (token) db.prepare("DELETE FROM platform_sessions WHERE token_hash=?").run(tokenHash(token));
}

export function userForPlatformSession(
  db: DB,
  token: string | null | undefined,
  now = new Date(),
): PlatformUser | undefined {
  if (!token) return undefined;
  const row = db.prepare(
    "SELECT u.id,u.provider,u.provider_subject,u.email,u.email_verified,u.name,u.avatar_url,u.status," +
      "u.last_login_at,u.created_at,u.updated_at FROM platform_sessions s " +
      "JOIN platform_users u ON u.id=s.user_id " +
      "WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'",
  ).get(tokenHash(token), now.toISOString()) as PlatformUserRow | undefined;
  if (row) {
    db.prepare(
      "UPDATE platform_sessions SET last_seen_at=datetime('now') " +
        "WHERE token_hash=? AND last_seen_at<datetime('now','-5 minutes')",
    )
      .run(tokenHash(token));
  }
  return shapeUser(row);
}

export function parseCookie(header: string | string[] | undefined, name: string): string | null {
  const source = Array.isArray(header) ? header.join(";") : header || "";
  for (const part of source.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return null; }
  }
  return null;
}

function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function authenticateHeaders(
  db: DB,
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): { user: PlatformUser; kind: "local" | "session" | "service" } | null {
  if (authMode(env) === "local") return { user: ensureLocalUser(db, env), kind: "local" };

  const serviceToken = env.ALIGNYARD_API_TOKEN?.trim();
  const suppliedBearer = bearerToken(headers.authorization);
  if (serviceToken && suppliedBearer && constantTimeEqual(serviceToken, suppliedBearer)) {
    const user = upsertPlatformUser(db, "service", {
      sub: "local-agent",
      name: "Alignyard Agent",
    });
    return { user, kind: "service" };
  }

  const sessionToken = parseCookie(headers.cookie, SESSION_COOKIE);
  const user = userForPlatformSession(db, sessionToken);
  if (user?.provider === "google" && !googleEmailAllowed(user, env)) return null;
  return user ? { user, kind: "session" } : null;
}

export function requireAuthentication(db: DB, env: NodeJS.ProcessEnv = process.env) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const authenticated = authenticateHeaders(db, req.headers, env);
      if (!authenticated) return res.status(401).json({ error: "请先登录 Alignyard" });
      req.alignyardUser = authenticated.user;
      req.alignyardAuthKind = authenticated.kind;
      next();
    } catch (error: any) {
      res.status(503).json({ error: String(error?.message || error) });
    }
  };
}

export function authenticatedUser(req: Request): PlatformUser {
  const user = (req as AuthenticatedRequest).alignyardUser;
  if (!user) throw new Error("请求缺少认证用户");
  return user;
}

export async function verifyGoogleCredential(
  credential: string,
  clientId: string,
  verifier: Pick<OAuth2Client, "verifyIdToken"> = new OAuth2Client(clientId),
): Promise<GoogleIdentity> {
  if (!credential?.trim()) throw new Error("缺少 Google credential");
  const ticket = await verifier.verifyIdToken({ idToken: credential, audience: clientId });
  const payload = ticket.getPayload();
  if (!payload?.sub) throw new Error("Google ID token 缺少 subject");
  return {
    sub: payload.sub,
    email: payload.email || null,
    email_verified: payload.email_verified === true,
    name: payload.name || null,
    picture: payload.picture || null,
  };
}

export function sessionCookieOptions(req: Request) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: req.secure || forwarded === "https",
    path: "/",
    maxAge: SESSION_AGE_SECONDS * 1000,
  };
}
