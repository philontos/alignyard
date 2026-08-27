import { test } from "node:test";
import assert from "node:assert/strict";
import { RUNNER_UTF8_LOCALE, utf8TerminalEnvironment } from "./terminal-env.ts";

test("browser tmux clients always receive a UTF-8 locale under launchd", () => {
  const env = utf8TerminalEnvironment({ PATH: "/usr/bin:/bin" });
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.LANG, RUNNER_UTF8_LOCALE);
  assert.equal(env.LC_ALL, RUNNER_UTF8_LOCALE);
  assert.equal(env.LC_CTYPE, RUNNER_UTF8_LOCALE);
});

test("a non-UTF-8 inherited locale cannot corrupt the browser terminal", () => {
  const env = utf8TerminalEnvironment({ LANG: "C", LC_ALL: "C", LC_CTYPE: "C" });
  assert.deepEqual(
    { LANG: env.LANG, LC_ALL: env.LC_ALL, LC_CTYPE: env.LC_CTYPE },
    { LANG: RUNNER_UTF8_LOCALE, LC_ALL: RUNNER_UTF8_LOCALE, LC_CTYPE: RUNNER_UTF8_LOCALE },
  );
});
