function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

export function createRunnerOnboarding({ api, authConfig, currentUser, toast }) {
  const state = { runners: [], latestVersions: {}, releaseCheckedAt: {}, dismissed: false, pollTimer: null };
  const element = (id) => document.getElementById(id);
  const enabled = () => authConfig()?.execution_mode === "runner";
  const online = () => state.runners.filter((runner) => runner.status === "online");
  const releaseKey = (runner) => runner.os === "darwin" && ["arm64", "x64"].includes(runner.arch)
    ? `${runner.os}-${runner.arch}`
    : null;
  const installedVersion = (runner) => typeof runner.capabilities?.version === "string"
    ? runner.capabilities.version
    : null;
  const versionState = (runner) => {
    const version = installedVersion(runner);
    const latest = state.latestVersions[releaseKey(runner)];
    return { version, latest, legacy: !version, outdated: !!version && !!latest && version !== latest };
  };

  function runnerStatusText(runner) {
    if (runner.status === "online") return "已连接";
    if (runner.status === "upgrade_required") return "协议不兼容";
    return runner.last_seen_at ? `离线 · 最后在线 ${formatDate(runner.last_seen_at)}` : "离线";
  }

  function renderIndicator() {
    const indicator = element("runner-indicator");
    const manage = element("manage-runner-button");
    indicator.hidden = !enabled();
    manage.hidden = !enabled();
    if (!enabled()) return;
    const count = online().length;
    const upgrades = state.runners.filter((runner) => {
      const version = versionState(runner);
      return version.legacy || version.outdated;
    }).length;
    indicator.classList.toggle("online", count > 0);
    element("runner-indicator-label").textContent = count
      ? `${count} 台在线${upgrades ? " · 可更新" : ""}`
      : "未连接";
  }

  function renderDialog() {
    const connected = online();
    const offline = state.runners.filter((runner) => runner.status !== "online");
    const legacy = state.runners.some((runner) => versionState(runner).legacy);
    element("runner-state").innerHTML = [...connected, ...offline].map((runner) => {
      const release = versionState(runner);
      const versionLabel = release.legacy
        ? "版本未知 · 需重新安装一次"
        : release.outdated
          ? `v${release.version} · 最新 v${release.latest}`
          : `v${release.version}`;
      const action = release.outdated
        ? `<button class="runner-upgrade-copy" type="button" data-runner-upgrade-copy>复制升级命令</button>`
        : "";
      return `<article class="runner-device ${runner.status === "online" ? "online" : ""}"><i></i>` +
        `<span><strong>${escapeHtml(runner.name)}</strong><small>${escapeHtml(runner.os)} · ${escapeHtml(runner.arch)} · ` +
        `${escapeHtml(runnerStatusText(runner))}</small><small>${escapeHtml(versionLabel)}</small></span>${action}</article>`;
    }).join("") || `<div class="runner-empty"><strong>还没有连接 Runner</strong><p>安装包自带 Node runtime；Codex、Claude、Kimi、gh、glab 继续使用你本机已有的安装和登录。</p></div>`;
    element("runner-install").hidden = connected.length > 0 && !legacy;
    element("runner-pair-button").textContent = legacy ? "生成一次性重装命令" : "生成 macOS 安装命令";
    element("runner-dialog-done").textContent = connected.length ? "完成" : "稍后安装";
    renderIndicator();
  }

  async function refreshLatestVersions() {
    const keys = [...new Set(state.runners.map(releaseKey).filter(Boolean))];
    await Promise.all(keys.map(async (key) => {
      if (Date.now() - (state.releaseCheckedAt[key] || 0) < 60_000) return;
      state.releaseCheckedAt[key] = Date.now();
      try {
        const response = await fetch(`/downloads/runner/stable/${key}/manifest.json`, { cache: "no-store" });
        if (!response.ok) return;
        const manifest = await response.json();
        if (typeof manifest.version === "string") state.latestVersions[key] = manifest.version;
      } catch {}
    }));
    renderIndicator();
    if (!element("runner-dialog").hidden) renderDialog();
  }

  function open({ automatic = false } = {}) {
    if (!enabled()) return;
    element("runner-error").textContent = "";
    element("runner-dialog").hidden = false;
    if (!automatic) state.dismissed = false;
    renderDialog();
  }

  function close() {
    element("runner-dialog").hidden = true;
    state.dismissed = true;
  }

  async function createPairing() {
    const button = element("runner-pair-button");
    button.disabled = true;
    element("runner-error").textContent = "";
    try {
      const pairing = await api("/api/runners/pairings", { method: "POST", body: "{}" });
      const command = `curl -fsSL '${location.origin}/downloads/install-runner-macos.sh' | bash -s -- --platform '${location.origin}' --code '${pairing.code}'`;
      element("runner-command-text").textContent = command;
      element("runner-command").hidden = false;
      element("runner-pair-expiry").textContent = `一次性配对码将在 ${formatDate(pairing.expires_at)} 失效。`;
    } catch (error) {
      element("runner-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function setRunners(runners, { automatic = true } = {}) {
    state.runners = Array.isArray(runners) ? runners : [];
    renderIndicator();
    if (!element("runner-dialog").hidden) renderDialog();
    if (automatic && enabled() && !online().length && !state.dismissed) open({ automatic: true });
  }

  async function refresh() {
    if (!currentUser() || !enabled()) return;
    try {
      setRunners(await api("/api/runners"));
      await refreshLatestVersions();
    } catch {}
  }

  function bind() {
    element("runner-indicator").addEventListener("click", () => open());
    element("manage-runner-button").addEventListener("click", () => {
      element("account-menu").hidden = true;
      open();
    });
    element("runner-dialog-close").addEventListener("click", close);
    element("runner-dialog-done").addEventListener("click", close);
    element("runner-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) close(); });
    element("runner-pair-button").addEventListener("click", createPairing);
    element("runner-state").addEventListener("click", async (event) => {
      if (!event.target.closest("[data-runner-upgrade-copy]")) return;
      await navigator.clipboard.writeText("$HOME/.local/bin/alignyard-runner upgrade");
      toast("升级命令已复制");
    });
    element("runner-command-copy").addEventListener("click", async () => {
      await navigator.clipboard.writeText(element("runner-command-text").textContent);
      toast("安装命令已复制");
    });
    renderIndicator();
    state.pollTimer ||= window.setInterval(() => void refresh(), 5_000);
  }

  return { bind, enabled, open, refresh, setRunners };
}
