import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import {
  SESSION_COOKIE,
  authMode,
  authenticateHeaders,
  createPlatformSession,
  ensureLocalUser,
  googleConfigurationError,
  googleEmailAllowed,
  parseCookie,
  upsertPlatformUser,
  userForPlatformSession,
  verifyGoogleCredential,
} from "./auth.ts";

function database() {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" });
  return db;
}

test("auth mode is local by default and Google when explicitly configured", () => {
  assert.equal(authMode({} as NodeJS.ProcessEnv), "local");
  assert.equal(authMode({ GOOGLE_CLIENT_ID: "client-id" } as NodeJS.ProcessEnv), "google");
  assert.equal(authMode({ ALIGNYARD_AUTH_MODE: "local", GOOGLE_CLIENT_ID: "client-id" } as NodeJS.ProcessEnv), "local");
  assert.throws(() => authMode({ ALIGNYARD_AUTH_MODE: "unknown" } as NodeJS.ProcessEnv));
});

test("Google mode requires an explicit account policy and service token", () => {
  assert.match(googleConfigurationError({ ALIGNYARD_AUTH_MODE: "google" } as NodeJS.ProcessEnv) || "", /GOOGLE_CLIENT_ID/);
  assert.match(googleConfigurationError({
    ALIGNYARD_AUTH_MODE: "google", GOOGLE_CLIENT_ID: "client-id",
  } as NodeJS.ProcessEnv) || "", /ALIGNYARD_API_TOKEN/);
  assert.match(googleConfigurationError({
    ALIGNYARD_AUTH_MODE: "google", GOOGLE_CLIENT_ID: "client-id", ALIGNYARD_API_TOKEN: "secret",
  } as NodeJS.ProcessEnv) || "", /ALIGNYARD_ALLOWED_EMAILS/);
  assert.equal(googleConfigurationError({
    ALIGNYARD_AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "client-id",
    ALIGNYARD_API_TOKEN: "secret",
    ALIGNYARD_ALLOWED_EMAILS: "phil@example.com, alice@example.com",
  } as NodeJS.ProcessEnv), null);
  assert.equal(googleEmailAllowed({ email: "PHIL@example.com", email_verified: true }, {
    ALIGNYARD_ALLOWED_EMAILS: "phil@example.com",
  } as NodeJS.ProcessEnv), true);
  assert.equal(googleEmailAllowed({ email: "other@example.com", email_verified: true }, {
    ALIGNYARD_ALLOWED_EMAILS: "phil@example.com",
  } as NodeJS.ProcessEnv), false);
});

test("Google users keep a stable id when mutable profile fields change", () => {
  const db = database();
  const first = upsertPlatformUser(db, "google", {
    sub: "google-subject-1",
    email: "old@example.com",
    email_verified: true,
    name: "旧名称",
  });
  const updated = upsertPlatformUser(db, "google", {
    sub: "google-subject-1",
    email: "new@example.com",
    email_verified: true,
    name: "新名称",
  });

  assert.equal(updated.id, first.id);
  assert.equal(updated.email, "new@example.com");
  assert.equal(updated.name, "新名称");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM platform_users").get() as { count: number }).count, 1);
});

test("sessions store only a hash and authenticate the opaque cookie", () => {
  const db = database();
  const user = ensureLocalUser(db, { ALIGNYARD_LOCAL_USER: "Phil" } as NodeJS.ProcessEnv);
  const now = new Date("2026-08-25T00:00:00.000Z");
  const session = createPlatformSession(db, user.id, now);
  const stored = db.prepare("SELECT token_hash FROM platform_sessions").get() as { token_hash: string };

  assert.notEqual(stored.token_hash, session.token);
  assert.equal(userForPlatformSession(db, session.token, now)?.id, user.id);
  assert.equal(userForPlatformSession(db, session.token, new Date("2026-09-02T00:00:00.000Z")), undefined);
  assert.equal(parseCookie(`other=1; ${SESSION_COOKIE}=${session.token}`, SESSION_COOKIE), session.token);
});

test("Google mode accepts either a browser session or the configured service token", () => {
  const db = database();
  const user = upsertPlatformUser(db, "google", {
    sub: "subject", name: "Phil", email: "phil@example.com", email_verified: true,
  });
  const session = createPlatformSession(db, user.id);
  const env = {
    ALIGNYARD_AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "client-id",
    ALIGNYARD_API_TOKEN: "service-secret",
    ALIGNYARD_ALLOWED_EMAILS: "phil@example.com",
  } as NodeJS.ProcessEnv;

  assert.equal(authenticateHeaders(db, { cookie: `${SESSION_COOKIE}=${session.token}` }, env)?.user.id, user.id);
  assert.equal(authenticateHeaders(db, { authorization: "Bearer service-secret" }, env)?.kind, "service");
  assert.equal(authenticateHeaders(db, {}, env), null);
  assert.equal(authenticateHeaders(db, { cookie: `${SESSION_COOKIE}=${session.token}` }, {
    ...env, ALIGNYARD_ALLOWED_EMAILS: "alice@example.com",
  }), null);
});

test("Google credential verification forwards the audience and returns only identity claims", async () => {
  let received: unknown;
  const verifier = {
    async verifyIdToken(input: unknown) {
      received = input;
      return {
        getPayload: () => ({
          sub: "subject",
          email: "phil@example.com",
          email_verified: true,
          name: "Phil",
          picture: "https://example.com/avatar.png",
        }),
      };
    },
  };
  const identity = await verifyGoogleCredential("id-token", "client-id", verifier as any);
  assert.deepEqual(received, { idToken: "id-token", audience: "client-id" });
  assert.deepEqual(identity, {
    sub: "subject",
    email: "phil@example.com",
    email_verified: true,
    name: "Phil",
    picture: "https://example.com/avatar.png",
  });
});
