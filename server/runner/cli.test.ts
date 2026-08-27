import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLaunchAgent } from "./cli.ts";
import { normalizePlatformUrl, runnerWebSocketUrl } from "./config.ts";

test("Runner URLs normalize to the platform HTTP and WebSocket endpoints", () => {
  assert.equal(normalizePlatformUrl("https://alignyard.example.com/"), "https://alignyard.example.com");
  assert.equal(runnerWebSocketUrl("https://alignyard.example.com"), "wss://alignyard.example.com/runner");
  assert.equal(normalizePlatformUrl("http://127.0.0.1:4500/"), "http://127.0.0.1:4500");
  assert.throws(() => normalizePlatformUrl("file:///tmp/platform"), /http/);
  assert.throws(() => normalizePlatformUrl("http://alignyard.example.com"), /https/);
  assert.throws(() => normalizePlatformUrl("https://user:secret@alignyard.example.com"), /用户名或密码/);
});

test("macOS LaunchAgent starts the self-contained Runner as the current user", () => {
  const plist = renderLaunchAgent("/Users/phil/.local/bin/alignyard-runner", "/Users/phil");
  assert.match(plist, /<string>\/Users\/phil\/\.local\/bin\/alignyard-runner<\/string><string>start<\/string>/);
  assert.doesNotMatch(plist, /<string>runner<\/string><string>start<\/string>/);
  assert.match(plist, /RunAtLoad/);
  assert.match(plist, /KeepAlive/);
  assert.match(plist, /EnvironmentVariables/);
  assert.match(plist, /<key>LANG<\/key><string>en_US\.UTF-8<\/string>/);
  assert.match(plist, /<key>LC_ALL<\/key><string>en_US\.UTF-8<\/string>/);
  assert.match(plist, /<key>LC_CTYPE<\/key><string>en_US\.UTF-8<\/string>/);
  assert.doesNotMatch(plist, /UserName|sudo/);
});
