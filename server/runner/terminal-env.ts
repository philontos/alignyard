export const RUNNER_UTF8_LOCALE = "en_US.UTF-8";

/**
 * tmux decides whether a client can display wide characters from that client's
 * locale. macOS LaunchAgents normally have no LANG/LC_* variables, which makes
 * tmux replace CJK cells with underscores even though the pane still contains
 * the correct Unicode text. Every browser attach PTY gets an explicit UTF-8
 * locale so its byte stream remains identical to the pane.
 */
export function utf8TerminalEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  result.LANG = RUNNER_UTF8_LOCALE;
  result.LC_ALL = RUNNER_UTF8_LOCALE;
  result.LC_CTYPE = RUNNER_UTF8_LOCALE;
  return result;
}
