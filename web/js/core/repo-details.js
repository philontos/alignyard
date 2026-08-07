// Pure presentation helpers for the repository-info sheet. Keeping URL
// redaction, date parsing, and status labels out of the DOM code makes the
// details view deterministic and easy to regression-test.

/**
 * A repository URL is display metadata, never a credential surface. The normal
 * registration flow stores HTTPS tokens separately, but redact URL userinfo as
 * a safety net for older/manual rows that embedded a token in the URL itself.
 */
export function displayGitUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw || !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.username = "";
      parsed.password = "";
    } else {
      parsed.password = "";
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

/** SQLite datetime() values are UTC but omit both the T and timezone marker. */
export function formatRepoDate(value, lang = "en") {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function statusLabel(status, translate) {
  const key = {
    ready: "repo.infoStatusReady",
    cloning: "repo.infoStatusChecking",
    error: "repo.infoStatusError",
  }[status];
  return key ? translate(key) : (status || translate("repo.infoStatusUnknown"));
}

/** Build the user-facing fields shared by local and node-owned repositories. */
export function repoDetailsData(repo, host, translate, lang = "en") {
  const status = String(repo?.status || "ready");
  return {
    id: Number(repo?.id),
    name: String(repo?.name || ""),
    host: host ? (host.kind === "local" ? translate("host.local") : String(host.name || "")) : "—",
    gitUrl: displayGitUrl(repo?.git_url),
    branch: String(repo?.default_branch || "main"),
    status,
    statusLabel: statusLabel(status, translate),
    createdAt: formatRepoDate(repo?.created_at, lang),
    error: String(repo?.error || ""),
  };
}
