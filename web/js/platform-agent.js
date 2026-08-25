import { connectPty, sendPtyResize } from "./core/pty-socket.js";
import { activateCodexUnicode } from "./core/terminal-unicode.js";

let active = null;
let notifyError = () => {};
let initialized = false;

function element(id) { return document.getElementById(id); }

function fit() {
  if (!active || element("agent-workspace").hidden) return;
  const { host, term } = active;
  const core = term._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  const viewport = host.querySelector(".xterm-viewport");
  const scrollArea = host.querySelector(".xterm-scroll-area");
  if (!cell?.width || !cell?.height || !viewport || !scrollArea) return;
  const styles = getComputedStyle(term.element);
  const paddingX = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
  const paddingY = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
  const scrollbar = Math.max(0, viewport.offsetWidth - scrollArea.offsetWidth);
  const width = host.clientWidth - paddingX - scrollbar;
  const height = host.clientHeight - paddingY;
  if (width <= 0 || height <= 0) return;
  const columns = Math.max(2, Math.floor(width / cell.width));
  const rows = Math.max(1, Math.floor(height / cell.height));
  if (term.cols !== columns || term.rows !== rows) term.resize(columns, rows);
  const size = `${term.cols}x${term.rows}`;
  if (size !== active.lastSize && sendPtyResize(active.socket, term.cols, term.rows)) active.lastSize = size;
}

function setConnectionState(label, state = "") {
  const status = element("agent-workspace-status");
  status.textContent = label;
  status.dataset.state = state;
}

function send(data) {
  if (!active?.socket || active.socket.readyState !== WebSocket.OPEN) return false;
  active.socket.send(data);
  active.term.focus();
  return true;
}

function disposeActiveTerminal() {
  if (!active) return;
  const closing = active;
  active = null;
  closing.observer?.disconnect();
  try { closing.socket.onclose = null; closing.socket.close(); } catch {}
  try { closing.term.dispose(); } catch {}
  closing.host.replaceChildren();
}

export function closePlatformAgentWorkspace() {
  element("agent-workspace").hidden = true;
  element("task-drawer").classList.remove("task-workspace-mode");
  document.body.classList.remove("agent-workspace-open");
  disposeActiveTerminal();
}

export function platformAgentWorkspaceIsOpen() {
  return !element("agent-workspace").hidden;
}

export function openPlatformAgentWorkspace(task) {
  const workspace = element("agent-workspace");
  const host = element("agent-terminal");
  const empty = element("agent-workspace-empty");
  const controls = workspace.querySelector(".agent-workspace-controls");
  element("agent-workspace-key").textContent = task.key;
  element("agent-workspace-title").textContent = task.title;
  workspace.hidden = false;
  element("task-drawer").classList.add("task-workspace-mode");
  document.body.classList.add("agent-workspace-open");

  if (!task?.runtime_task_id || !task.runtime_session) {
    disposeActiveTerminal();
    workspace.classList.add("is-empty");
    host.hidden = true;
    empty.hidden = false;
    controls.hidden = true;
    setConnectionState("等待启动", "idle");
    return;
  }

  workspace.classList.remove("is-empty");
  host.hidden = false;
  empty.hidden = true;
  controls.hidden = false;
  if (active?.taskId === task.runtime_task_id && active.session === task.runtime_session) {
    requestAnimationFrame(fit);
    return;
  }

  disposeActiveTerminal();
  setConnectionState("正在连接…", "connecting");

  const agent = task.runtime_agent === "codex" || task.runtime_agent === "kimi" ? task.runtime_agent : "claude";
  const term = new Terminal({
    fontSize: 13,
    fontFamily: "Menlo, Monaco, Consolas, monospace",
    cursorBlink: true,
    allowProposedApi: agent === "codex",
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: true,
    theme: {
      background: "#1a1613",
      foreground: "#ddd4c8",
      cursor: "#d97757",
      cursorAccent: "#1a1613",
      selectionBackground: "#d9775740",
    },
  });
  if (agent === "codex") {
    try { activateCodexUnicode(term, agent); } catch {}
  }
  term.open(host);

  const terminalState = { taskId: task.runtime_task_id, session: task.runtime_session, host, term, socket: null, observer: null, lastSize: "" };
  active = terminalState;
  term.onData((data) => send(data));
  terminalState.socket = connectPty(`session=${encodeURIComponent(task.runtime_session)}`, {
    lang: "zh",
    onOpen: () => {
      if (active !== terminalState) return;
      setConnectionState("Agent 已连接", "connected");
      requestAnimationFrame(() => { fit(); term.focus(); });
    },
    onData: (data) => { if (active === terminalState) term.write(data); },
    onClose: () => {
      if (active !== terminalState) return;
      setConnectionState("连接已断开", "closed");
      term.write("\r\n\x1b[90mAgent 连接已断开，关闭后可重新进入。\x1b[0m\r\n");
    },
  });
  try {
    terminalState.observer = new ResizeObserver(() => requestAnimationFrame(fit));
    terminalState.observer.observe(host);
  } catch {}
  requestAnimationFrame(fit);
}

export function initPlatformAgentWorkspace({ onError } = {}) {
  if (initialized) return;
  initialized = true;
  if (onError) notifyError = onError;
  element("agent-workspace-close").addEventListener("click", closePlatformAgentWorkspace);
  document.querySelectorAll("[data-agent-key]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.agentKey;
    const data = key === "enter" ? "\r" : key === "interrupt" ? "\x03" : key;
    if (!send(data)) notifyError("Agent 尚未连接");
  }));
  window.addEventListener("resize", () => requestAnimationFrame(fit));
}
