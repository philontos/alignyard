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
  const state = { runners: [], dismissed: false, pollTimer: null };
  const element = (id) => document.getElementById(id);
  const enabled = () => authConfig()?.execution_mode === "runner";
  const online = () => state.runners.filter((runner) => runner.status === "online");

  function renderIndicator() {
    const indicator = element("runner-indicator");
    const manage = element("manage-runner-button");
    indicator.hidden = !enabled();
    manage.hidden = !enabled();
    if (!enabled()) return;
    const count = online().length;
    indicator.classList.toggle("online", count > 0);
    element("runner-indicator-label").textContent = count ? `${count} 台在线` : "未连接";
  }

  function renderDialog() {
    const connected = online();
    const offline = state.runners.filter((runner) => runner.status !== "online");
    element("runner-state").innerHTML = [...connected, ...offline].map((runner) =>
      `<article class="runner-device ${runner.status === "online" ? "online" : ""}"><i></i><span>` +
      `<strong>${escapeHtml(runner.name)}</strong><small>${escapeHtml(runner.os)} · ${escapeHtml(runner.arch)} · ` +
      `${runner.status === "online" ? "已连接" : "离线"}</small></span></article>`,
    ).join("") || `<div class="runner-empty"><strong>还没有连接 Runner</strong><p>安装包自带 Node runtime；Codex、Claude、Kimi、gh、glab 继续使用你本机已有的安装和登录。</p></div>`;
    element("runner-install").hidden = connected.length > 0;
    element("runner-dialog-done").textContent = connected.length ? "完成" : "稍后安装";
    renderIndicator();
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
    try { setRunners(await api("/api/runners")); } catch {}
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
    element("runner-command-copy").addEventListener("click", async () => {
      await navigator.clipboard.writeText(element("runner-command-text").textContent);
      toast("安装命令已复制");
    });
    renderIndicator();
    state.pollTimer ||= window.setInterval(() => void refresh(), 5_000);
  }

  return { bind, enabled, open, refresh, setRunners };
}
