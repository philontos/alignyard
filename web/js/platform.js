import {
  closePlatformAgentWorkspace,
  initPlatformAgentWorkspace,
  openPlatformAgentWorkspace,
  platformAgentWorkspaceIsOpen,
} from "./platform-agent.js";
import {
  closeCodeView,
  initCodeView,
  isCodeViewOpen,
  openTaskCodeContext,
} from "./features/codeview.js";

const state = {
  view: "tasks",
  tasks: [],
  repositories: [],
  taskFilter: "all",
  selectedTask: null,
  pendingActions: new Set(),
  loading: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

const statusLabels = {
  draft: "草稿",
  review: "待审核",
  approved: "已通过",
};

const protocolStateLabels = {
  uninitialized: "未初始化",
  initializing: "初始化中",
  ready: "已就绪",
  invalid: "初始化无效",
};

function repositoryProtocolState(repository) {
  return repository.protocol_state || (repository.protocol_initialized ? "ready" : "uninitialized");
}

function formatDate(value, compact = false) {
  if (!value) return "—";
  const raw = String(value);
  const date = new Date(raw.includes("T") || raw.endsWith("Z") ? raw : `${raw.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return raw;
  if (compact) return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function initial(value) {
  const text = String(value || "?").trim();
  return text.slice(0, 1).toUpperCase() || "?";
}

function toast(message, kind = "success") {
  const element = document.createElement("div");
  element.className = `toast ${kind === "error" ? "error" : ""}`;
  element.textContent = message;
  $("#toast-region").append(element);
  setTimeout(() => element.remove(), 2800);
}

let confirmDialogResolve = null;
let confirmDialogPreviousFocus = null;

function closeConfirmDialog(confirmed = false) {
  const dialog = $("#confirm-dialog");
  if (dialog.hidden) return;
  dialog.hidden = true;
  const resolve = confirmDialogResolve;
  const previousFocus = confirmDialogPreviousFocus;
  confirmDialogResolve = null;
  confirmDialogPreviousFocus = null;
  if (previousFocus?.isConnected) previousFocus.focus();
  if (resolve) resolve(confirmed);
}

function confirmDialog({ title, message, detail = "", confirmText = "确认" }) {
  if (confirmDialogResolve) closeConfirmDialog(false);
  confirmDialogPreviousFocus = document.activeElement;
  $("#confirm-dialog-title").textContent = title;
  $("#confirm-dialog-message").textContent = message;
  $("#confirm-dialog-detail").textContent = detail;
  $("#confirm-dialog-submit").textContent = confirmText;
  $("#confirm-dialog").hidden = false;
  return new Promise((resolve) => {
    confirmDialogResolve = resolve;
    setTimeout(() => $("#confirm-dialog-cancel").focus(), 0);
  });
}

async function copyCommand(command) {
  try {
    await navigator.clipboard.writeText(command);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = command;
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  toast(`已复制：${command}`);
}

function statusPill(status) {
  return `<span class="status-pill status-${escapeHtml(status)}"><i></i>${escapeHtml(statusLabels[status] || status)}</span>`;
}

function repositoryChips(repositories) {
  if (!repositories?.length) return `<span class="repo-chip"><span>未关联</span></span>`;
  const visible = repositories.slice(0, 3).map((repo) => `<span class="repo-chip ${repo.mode === "reference" ? "reference" : ""}"><i></i><span>${escapeHtml(repo.name)}</span></span>`).join("");
  const more = repositories.length > 3 ? `<span class="repo-chip"><span>+${repositories.length - 3}</span></span>` : "";
  return visible + more;
}

function filteredTasks() {
  const priorities = { review: 0, draft: 1, approved: 2 };
  return state.tasks.filter((task) => {
    if (state.taskFilter === "mine" && task.owner !== "Phil") return false;
    if (state.taskFilter === "review" && task.status !== "review") return false;
    return true;
  }).sort((left, right) => (priorities[left.status] ?? 9) - (priorities[right.status] ?? 9));
}

function renderTaskList() {
  const target = $("#task-list");
  const tasks = filteredTasks();
  target.classList.remove("loading-block");
  if (!tasks.length) {
    target.classList.add("is-empty");
    target.innerHTML = `<div class="task-empty" aria-label="暂无 Task"></div>`;
    return;
  }
  target.classList.remove("is-empty");
  target.innerHTML = tasks.map((task) => `<button class="task-row" type="button" data-task-key="${escapeHtml(task.key)}">
    <span class="task-main"><span class="task-key-line"><span class="task-key">${escapeHtml(task.key)}</span>${statusPill(task.status)}</span><strong class="task-title">${escapeHtml(task.title)}</strong></span>
    <span class="repo-chips">${repositoryChips(task.repositories)}</span>
    <span class="task-owner"><span class="mini-avatar">${escapeHtml(initial(task.owner))}</span>${escapeHtml(task.owner)}</span>
  </button>`).join("");
  $$('[data-task-key]', target).forEach((button) => button.addEventListener("click", () => openTaskDetail(button.dataset.taskKey)));
}

function renderTaskSummary() {
  $("#nav-task-count").textContent = state.tasks.length;
}

function renderTasks() {
  renderTaskSummary();
  renderTaskList();
}

function renderRepositories() {
  const target = $("#repository-grid");
  $("#nav-repo-count").textContent = state.repositories.length;
  $("#repo-total-label").textContent = `${state.repositories.length} Repositories`;
  target.classList.remove("loading-block");
  if (!state.repositories.length) {
    target.classList.add("is-empty");
    target.innerHTML = `<div class="repo-empty" aria-label="暂无 Repository"></div>`;
    return;
  }
  target.classList.remove("is-empty");
  target.innerHTML = state.repositories.map((repo) => {
    const taskCount = state.tasks.filter((task) => task.repositories.some((item) => item.id === repo.id)).length;
    const initTask = state.tasks.find((task) =>
      task.task_type === "repository_init" && task.status !== "approved" &&
      task.repositories.some((item) => item.id === repo.id)
    );
    const protocolState = repositoryProtocolState(repo);
    const label = `${protocolStateLabels[protocolState] || protocolState}；点击刷新`;
    const primaryAction = protocolState === "ready"
      ? `<button class="button secondary small" type="button" data-task-from-repo="${repo.id}">＋ Task</button>`
      : initTask
        ? `<button class="button secondary small" type="button" data-task-key="${escapeHtml(initTask.key)}">${escapeHtml(initTask.key)}</button>`
        : `<button class="button secondary small" type="button" data-init-repository="${repo.id}">Initialize</button>`;
    return `<article class="repository-row">
      <button class="protocol-indicator state-${escapeHtml(protocolState)}" type="button" data-refresh-protocol="${repo.id}" aria-label="${escapeHtml(label)}" title="${escapeHtml(repo.protocol_error || label)}"><i></i></button>
      <span class="repository-main"><strong>${escapeHtml(repo.name)}</strong><small title="${escapeHtml(repo.git_url)}">${escapeHtml(repo.git_url)}</small><em>${escapeHtml(protocolStateLabels[protocolState] || protocolState)}</em></span>
      <span class="repository-branch">${escapeHtml(repo.default_branch)}</span>
      <span class="repository-task-count">${taskCount} Tasks</span>
      <span class="repository-actions">${primaryAction}<button class="button danger small" type="button" data-delete-repository="${repo.id}">删除</button></span>
    </article>`;
  }).join("");
  $$('[data-task-from-repo]', target).forEach((button) => button.addEventListener("click", () => openTaskDialog(Number(button.dataset.taskFromRepo))));
  $$('[data-task-key]', target).forEach((button) => button.addEventListener("click", () => openTaskDetail(button.dataset.taskKey)));
  $$('[data-init-repository]', target).forEach((button) => button.addEventListener("click", () => initializeRepository(Number(button.dataset.initRepository), button)));
  $$('[data-delete-repository]', target).forEach((button) => button.addEventListener("click", () => deleteRepository(Number(button.dataset.deleteRepository), button)));
  $$('[data-refresh-protocol]', target).forEach((button) => button.addEventListener("click", () => refreshProtocol(Number(button.dataset.refreshProtocol), button)));
}

function renderAll() {
  renderTasks();
  renderRepositories();
}

function setView(view, { updateHash = true } = {}) {
  const allowed = ["tasks", "repositories"];
  const next = allowed.includes(view) ? view : "tasks";
  state.view = next;
  $$(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${next}`));
  $$(".nav-item[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === next));
  const active = $(`#view-${next}`);
  $("#breadcrumb-current").textContent = active?.dataset.title || "Tasks";
  document.title = `Alignyard · ${active?.dataset.title || "Tasks"}`;
  if (updateHash && location.hash !== `#${next}`) history.replaceState(null, "", `#${next}`);
  closeMobileNav();
}

function openMobileNav() {
  $("#sidebar").classList.add("open");
  $("#mobile-scrim").classList.add("open");
}

function closeMobileNav() {
  $("#sidebar").classList.remove("open");
  $("#mobile-scrim").classList.remove("open");
}

function taskRepositoryOptions(preselectId) {
  const target = $("#task-repository-options");
  if (!state.repositories.length) {
    target.innerHTML = `<div class="empty-state" style="min-height:120px;padding:18px"><div><h3>还没有 Repository</h3><p>先登记一个仓库定位信息，再创建 Task。</p><button class="button secondary small" type="button" data-add-repository>登记 Repository</button></div></div>`;
    wireDynamicButtons(target);
    return;
  }
  target.innerHTML = state.repositories.map((repo) => {
    const protocolState = repositoryProtocolState(repo);
    const ready = protocolState === "ready";
    const selected = ready && repo.id === preselectId;
    return `<label class="repo-option ${selected ? "selected" : ""}">
      <input type="checkbox" value="${repo.id}" ${selected ? "checked" : ""} />
      <span><strong>${escapeHtml(repo.name)}</strong><small>${escapeHtml(repo.git_url)} · ${escapeHtml(protocolStateLabels[protocolState] || protocolState)}</small></span>
      <select aria-label="${escapeHtml(repo.name)} 关联方式"><option value="editable" ${ready ? "" : "disabled"}>editable</option><option value="reference" ${ready ? "" : "selected"}>reference</option></select>
      <input type="text" value="${escapeHtml(repo.default_branch)}" aria-label="${escapeHtml(repo.name)} 基准分支" />
    </label>`;
  }).join("");
  $$('.repo-option input[type="checkbox"]', target).forEach((checkbox) => checkbox.addEventListener("change", () => checkbox.closest(".repo-option").classList.toggle("selected", checkbox.checked)));
}

function openTaskDialog(preselectId, defaults = {}) {
  const form = $("#create-task-form");
  form.reset();
  form.elements.owner.value = "Phil";
  form.elements.title.value = defaults.title || "";
  form.elements.description.value = defaults.description || "";
  $("#task-form-error").textContent = "";
  taskRepositoryOptions(preselectId);
  $("#create-task-dialog").hidden = false;
  setTimeout(() => form.elements.title.focus(), 0);
}

async function initializeRepository(repositoryId, button) {
  const repository = state.repositories.find((item) => item.id === repositoryId);
  if (!repository) return;
  button.disabled = true;
  try {
    const result = await api(`/api/platform/repositories/${repositoryId}/initialize`, {
      method: "POST",
      body: JSON.stringify({ owner: "Phil" }),
    });
    const taskIndex = state.tasks.findIndex((task) => task.key === result.task.key);
    if (taskIndex >= 0) state.tasks[taskIndex] = result.task;
    else state.tasks.unshift(result.task);
    const repositoryIndex = state.repositories.findIndex((item) => item.id === repositoryId);
    if (repositoryIndex >= 0 && result.repository) state.repositories[repositoryIndex] = result.repository;
    renderAll();
    setView("tasks");
    openTaskDetail(result.task.key);
    toast(`${result.task.key} 初始化 Agent 已启动`);
  } catch (error) {
    toast(error.message, "error");
    await loadData({ silent: true });
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function deleteRepository(repositoryId, button) {
  const repository = state.repositories.find((item) => item.id === repositoryId);
  if (!repository) return;
  const confirmed = await confirmDialog({
    title: "删除 Repository？",
    message: `确定要删除「${repository.name}」吗？`,
    detail: "平台元数据和本机 clone 都会移除。已被 Task 引用的 Repository 不会被删除。",
    confirmText: "删除 Repository",
  });
  if (!confirmed) return;
  button.disabled = true;
  try {
    await api(`/api/platform/repositories/${repositoryId}`, { method: "DELETE" });
    state.repositories = state.repositories.filter((item) => item.id !== repositoryId);
    renderAll();
    toast(`${repository.name} 已删除`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function deletePlatformTask(task, button) {
  const requestLabel = taskChangeRequestLabel(task);
  const remoteDetail = task.pr_state === "open"
    ? `打开的 ${requestLabel} #${task.pr_number} 会关闭，并尝试清理远端工作分支。`
    : "Repository 本身不会被删除。";
  const confirmed = await confirmDialog({
    title: "删除 Task？",
    message: `确定要删除「${task.key} · ${task.title}」吗？`,
    detail: `关联的 Agent session、worktree、本地 runtime Task 和工程知识快照都会清理。${remoteDetail}`,
    confirmText: "删除 Task",
  });
  if (!confirmed) return;
  button.disabled = true;
  try {
    await api(`/api/platform/tasks/${encodeURIComponent(task.key)}`, { method: "DELETE" });
    closeTaskDetail();
    await loadData({ silent: true });
    toast(`${task.key} 已删除`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function closeTaskDialog() { $("#create-task-dialog").hidden = true; }
function openRepositoryDialog() {
  const form = $("#add-repository-form");
  form.reset();
  $("#repo-form-error").textContent = "";
  $("#add-repository-dialog").hidden = false;
  setTimeout(() => form.elements.name.focus(), 0);
}
function closeRepositoryDialog() { $("#add-repository-dialog").hidden = true; }

async function submitTask(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const repositories = $$(".repo-option", form).filter((row) => $('input[type="checkbox"]', row).checked).map((row) => ({
    repository_id: Number($('input[type="checkbox"]', row).value),
    mode: $("select", row).value,
    base_branch: $('input[type="text"]', row).value.trim(),
  }));
  const payload = {
    title: form.elements.title.value.trim(),
    description: form.elements.description.value.trim(),
    owner: form.elements.owner.value.trim(),
    repositories,
  };
  const submit = $("#create-task-submit");
  submit.disabled = true;
  submit.textContent = "创建中…";
  $("#task-form-error").textContent = "";
  try {
    const task = await api("/api/platform/tasks", { method: "POST", body: JSON.stringify(payload) });
    state.tasks.unshift(task);
    closeTaskDialog();
    renderAll();
    setView("tasks");
    toast(`${task.key} 已创建`);
    openTaskDetail(task.key);
  } catch (error) {
    $("#task-form-error").textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = "创建 Task";
  }
}

async function submitRepository(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const localPayload = {
    name: String(values.name || "").trim(),
    git_url: String(values.git_url || "").trim(),
    default_branch: String(values.default_branch || "").trim(),
    token: String(values.token || "").trim() || null,
  };
  const submit = $("#add-repository-submit");
  submit.disabled = true;
  submit.textContent = "添加中…";
  $("#repo-form-error").textContent = "";
  try {
    const localResult = await api("/api/repos", { method: "POST", body: JSON.stringify(localPayload) });
    const localRepositories = await api("/api/repos");
    const localRepository = localRepositories.find((item) => item.id === localResult.id);
    if (!localRepository) throw new Error("本地 Repository 添加后未找到");
    localPayload.default_branch = localRepository.default_branch;
    let repository;
    try {
      repository = await api("/api/platform/repositories", {
        method: "POST",
        body: JSON.stringify({ ...localPayload, token: undefined, created_by: "Phil" }),
      });
    } catch (error) {
      const repositories = await api("/api/platform/repositories");
      const normalize = (value) => String(value || "").trim().replace(/\/+$/, "").replace(/\.git$/i, "");
      repository = repositories.find((item) => normalize(item.git_url) === normalize(localPayload.git_url));
      if (!repository) throw error;
    }
    try {
      repository = await api(`/api/platform/repositories/${repository.id}/refresh`, { method: "POST" });
    } catch { /* The dot remains off until the default branch can be checked. */ }
    state.repositories = await api("/api/platform/repositories");
    closeRepositoryDialog();
    renderAll();
    if (!$("#create-task-dialog").hidden) taskRepositoryOptions(repository.id);
    toast(`${repository.name} 已添加`);
  } catch (error) {
    $("#repo-form-error").textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = "添加 Repository";
  }
}

async function refreshProtocol(repositoryId, button) {
  button.disabled = true;
  try {
    const repository = await api(`/api/platform/repositories/${repositoryId}/refresh`, { method: "POST" });
    const index = state.repositories.findIndex((item) => item.id === repositoryId);
    if (index >= 0) state.repositories[index] = repository;
    renderRepositories();
    const protocolState = repositoryProtocolState(repository);
    toast(`.alignyard：${protocolStateLabels[protocolState] || protocolState}`, protocolState === "invalid" ? "error" : "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function artifactKind(kind) {
  const normalized = String(kind || "docs").toLowerCase();
  if (normalized === "adr") return "adr";
  if (normalized === "spec" || normalized === "specs") return "specs";
  return "docs";
}

function detailRepository(repo) {
  return `<article class="detail-repo"><div><strong>${escapeHtml(repo.name)}</strong><small>${escapeHtml(repo.git_url)}</small></div><span class="mode-badge ${repo.mode === "reference" ? "reference" : ""}">${escapeHtml(repo.mode)}</span><div><strong>${escapeHtml(repo.base_branch)}</strong><small>${escapeHtml(repo.work_branch || "固定为只读上下文")}</small></div></article>`;
}

function taskChangeRequestLabel(task) {
  const repository = task.repositories.find((item) => item.mode === "editable");
  return repository?.forge_kind === "github" ? "PR" : repository?.forge_kind === "gitlab" ? "MR" : "合并请求";
}

function pendingAction(task, action) {
  return state.pendingActions.has(`${task.key}:${action}`);
}

function taskNextAction(task) {
  if (task.task_type === "repository_init") return initTaskActions(task);
  if (task.status === "draft") return `<button class="button secondary" type="button" data-set-status="review">提交审核</button>`;
  if (task.status === "review") return `<button class="button secondary" type="button" data-set-status="draft">要求修改</button><button class="button primary" type="button" data-set-status="approved">审核通过</button>`;
  return "";
}

function initWorkflowStage(task) {
  const repository = task.repositories.find((item) => item.mode === "editable");
  const requestLabel = taskChangeRequestLabel(task);
  if (task.pr_state === "merged" && repository?.protocol_state === "ready") {
    const note = task.workflow_error
      ? `Repository 已完成初始化；本地清理提示：${task.workflow_error}`
      : `${requestLabel} 已合并，Repository 已完成初始化。`;
    return { key: "merged", label: "已合并", note };
  }
  if (task.workflow_error || task.runtime_error) return { key: "error", label: "需要处理", note: task.workflow_error || task.runtime_error };
  if (task.pr_state === "merged") return { key: "error", label: "等待完成初始化", note: `${requestLabel} 已合并，正在确认默认分支上的 Alignyard 文件。` };
  if (task.status === "approved" && task.pr_state === "open") return { key: "pr", label: `${requestLabel} 待合并`, note: `Review 已批准，${requestLabel} 已创建，等待人工确认合并。` };
  if (task.status === "review") return { key: "review", label: "等待 Review", note: `Agent worktree 已冻结；确认工程知识后创建 ${requestLabel}。` };
  if (task.status === "draft" && task.pr_state === "open") return { key: "paused", label: "要求修改", note: `${requestLabel} 保持打开；继续 Agent 修改并 sync 后重新提交 Review。` };
  if (repository?.manifest_status === "valid") return { key: "ready", label: "可提交 Review", note: `Agent 已提交并同步 ${task.artifacts?.length || 0} 个工程知识产物。` };
  if (task.runtime_task_id && task.runtime_alive) return { key: "running", label: "Agent 执行中", note: "Agent 正在初始化 worktree；产物 sync 后这里会自动更新。" };
  if (task.runtime_task_id) return { key: "paused", label: "Agent 已暂停", note: "worktree 已保留，可以进入工作区检查或继续 Agent。" };
  return { key: "waiting", label: "等待启动", note: "启动后平台会自动创建 worktree、工作分支和 Agent session。" };
}

function initWorkflowPanel(task) {
  const stage = initWorkflowStage(task);
  const requestLabel = taskChangeRequestLabel(task);
  const stepState = (name) => {
    const order = ["waiting", "running", "paused", "error", "ready", "review", "pr", "merged"];
    const positions = { agent: 1, review: 5, pr: 6, merge: 7 };
    const current = order.indexOf(stage.key);
    const target = positions[name];
    if (name === "agent" && current >= 1 && current <= 3) return "active";
    return current > target ? "done" : current === target ? "active" : "pending";
  };
  return `<section class="init-workflow state-${escapeHtml(stage.key)}">
    <div class="init-workflow-head"><div><span>REPOSITORY INIT</span><strong>${escapeHtml(stage.label)}</strong></div><i></i></div>
    <p>${escapeHtml(stage.note || "")}</p>
    <ol class="workflow-steps">
      <li class="${stepState("agent")}"><i>1</i><span>Agent 初始化</span></li>
      <li class="${stepState("review")}"><i>2</i><span>人工 Review</span></li>
      <li class="${stepState("pr")}"><i>3</i><span>创建 ${requestLabel}</span></li>
      <li class="${stepState("merge")}"><i>4</i><span>确认合并</span></li>
    </ol>
  </section>`;
}

function initTaskActions(task) {
  const repository = task.repositories.find((item) => item.mode === "editable");
  const requestLabel = taskChangeRequestLabel(task);
  const actions = [];
  if (task.runtime_task_id && task.runtime_has_worktree) {
    actions.push(`<button class="button secondary" type="button" data-open-agent>进入 Agent 工作区</button>`);
  }
  if (task.status === "draft" && !task.runtime_task_id) {
    actions.push(`<button class="button primary" type="button" data-run-init>开始初始化</button>`);
  } else if (task.status === "draft" && repository?.manifest_status === "valid") {
    actions.push(`<button class="button primary" type="button" data-init-review>提交 Review</button>`);
  } else if (task.status === "draft" && !task.runtime_alive) {
    actions.push(`<button class="button primary" type="button" data-run-init>继续 Agent</button>`);
  } else if (task.status === "review") {
    actions.push(`<button class="button secondary" type="button" data-set-status="draft">要求修改</button>`);
    actions.push(`<button class="button primary" type="button" data-init-pr ${pendingAction(task, "pull-request") ? "disabled" : ""}>${pendingAction(task, "pull-request") ? `正在创建 ${requestLabel}…` : `审核通过并创建 ${requestLabel}`}</button>`);
  } else if (task.status === "approved" && task.pr_state === "open") {
    actions.push(`<button class="button secondary" type="button" data-set-status="draft">要求修改</button>`);
    actions.push(`<a class="button secondary link" href="${escapeHtml(task.pr_url)}" target="_blank" rel="noreferrer">查看 ${requestLabel} #${task.pr_number}</a>`);
    actions.push(`<button class="button primary" type="button" data-init-merge ${pendingAction(task, "merge") ? "disabled" : ""}>${pendingAction(task, "merge") ? `正在合并 ${requestLabel}…` : `合并 ${requestLabel}`}</button>`);
  } else if (task.status === "approved" && task.pr_state === "merged" && repository?.protocol_state !== "ready") {
    actions.push(`<a class="button secondary link" href="${escapeHtml(task.pr_url)}" target="_blank" rel="noreferrer">查看 ${requestLabel} #${task.pr_number}</a>`);
    actions.push(`<button class="button primary" type="button" data-init-merge>重试完成初始化</button>`);
  } else if (task.pr_url) {
    actions.push(`<a class="button secondary link" href="${escapeHtml(task.pr_url)}" target="_blank" rel="noreferrer">查看 ${requestLabel} #${task.pr_number}</a>`);
  }
  return actions.join("");
}

function taskLocalCommands(task) {
  const repository = task.repositories.find((item) => item.mode === "editable");
  if (!repository) return [];
  const sync = `ay sync . --platform ${location.origin} --task ${task.key} --repository-id ${repository.id}`;
  return task.task_type === "repository_init"
    ? ["ay init .", "ay new doc overview --scope shared --title \"仓库概览\"", "ay validate .", sync]
    : ["ay validate .", sync];
}

function openTaskChanges(task, path = null) {
  if (!task.runtime_task_id || !task.runtime_has_worktree) {
    toast("Task worktree 已清理，当前无法读取本地 diff", "error");
    return;
  }
  openTaskCodeContext(task.runtime_task_id, `${task.key} ${task.title}`, {
    tab: "changes",
    ...(path ? { path } : {}),
  });
}

function openTaskDetail(key) {
  const task = state.tasks.find((item) => item.key === key);
  if (!task) return;
  state.selectedTask = task;
  const commands = taskLocalCommands(task);
  const commandList = commands.map((command, index) => `<div class="detail-command"><span>${escapeHtml(command)}</span><button type="button" data-copy-command="${index}">复制</button></div>`).join("");
  const workflowNote = task.task_type === "repository_init"
    ? `${initWorkflowPanel(task)}<details class="manual-workflow"><summary>手动模式与诊断命令</summary><p>自动 Agent 无法完成时，才需要在保留的 worktree 中执行这些命令。</p>${commandList}</details>`
    : "";
  const canInspectChanges = !!task.runtime_task_id && !!task.runtime_has_worktree;
  const artifacts = task.artifacts?.length ? task.artifacts.map((artifact) => `<button class="artifact-row" type="button" data-artifact-path="${escapeHtml(artifact.path)}" ${canInspectChanges ? "" : "disabled"}><span class="artifact-kind ${artifactKind(artifact.kind)}">${escapeHtml(artifactKind(artifact.kind).slice(0, 4))}</span><span><strong>${escapeHtml(artifact.title || artifact.path)}</strong><small>${escapeHtml(artifact.path)}</small></span><span>${escapeHtml(artifact.review_status)} <i aria-hidden="true">›</i></span></button>`).join("") : `<div class="detail-empty">尚未收到 manifest 结果。成员在本地执行 <code>ay sync</code> 后，这里会显示 docs、specs 和 ADR 的差异。</div>`;
  $("#task-detail").innerHTML = `<div class="detail-top"><span class="task-key">${escapeHtml(task.key)}</span><h1>${escapeHtml(task.title)}</h1><p>${escapeHtml(task.description || "尚未填写需求说明")}</p></div>
    <div class="detail-meta">${statusPill(task.status)}<span>负责人：${escapeHtml(task.owner)}</span><span>创建于 ${escapeHtml(formatDate(task.created_at))}</span></div>
    ${workflowNote}${task.task_type === "repository_init" ? "" : commandList}
    <section class="detail-section"><div class="detail-section-head"><h2>Repositories · ${task.repositories.length}</h2><span class="protocol-badge">peer worktrees</span></div><div class="detail-repos">${task.repositories.map(detailRepository).join("")}</div></section>
    <section class="detail-section"><div class="detail-section-head"><h2>工程知识 · ${task.artifacts?.length || 0}</h2>${canInspectChanges ? `<button class="text-button review-changes" type="button" data-open-task-changes>查看全部变更</button>` : `<span class="protocol-badge">manifest snapshot</span>`}</div><div class="artifact-list">${artifacts}</div></section>
    <div class="detail-actions">${taskNextAction(task)}<button class="button danger task-delete-action" type="button" data-delete-task>删除 Task</button></div>`;
  $("#task-drawer").hidden = false;
  $$('[data-copy-command]', $("#task-detail")).forEach((button) => button.addEventListener("click", () => copyCommand(commands[Number(button.dataset.copyCommand)])));
  $$('[data-set-status]', $("#task-detail")).forEach((button) => button.addEventListener("click", () => setTaskStatus(task.key, button.dataset.setStatus)));
  $('[data-run-init]', $("#task-detail"))?.addEventListener("click", (event) => runInitTask(task.key, event.currentTarget));
  $('[data-open-agent]', $("#task-detail"))?.addEventListener("click", () => openPlatformAgentWorkspace(task));
  $('[data-open-task-changes]', $("#task-detail"))?.addEventListener("click", () => openTaskChanges(task));
  $$('[data-artifact-path]', $("#task-detail")).forEach((button) => button.addEventListener("click", () => openTaskChanges(task, button.dataset.artifactPath)));
  $('[data-init-review]', $("#task-detail"))?.addEventListener("click", (event) => initWorkflowAction(task.key, "review", event.currentTarget, "已提交 Review"));
  const requestLabel = taskChangeRequestLabel(task);
  $('[data-init-pr]', $("#task-detail"))?.addEventListener("click", (event) => initWorkflowAction(task.key, "pull-request", event.currentTarget, `Review 已批准，${requestLabel} 已创建`));
  $('[data-init-merge]', $("#task-detail"))?.addEventListener("click", (event) => initWorkflowAction(task.key, "merge", event.currentTarget, `${requestLabel} 已合并，Repository 已就绪`));
  $('[data-delete-task]', $("#task-detail"))?.addEventListener("click", (event) => deletePlatformTask(task, event.currentTarget));
}

function closeTaskDetail() {
  if (platformAgentWorkspaceIsOpen()) closePlatformAgentWorkspace();
  $("#task-drawer").hidden = true;
  state.selectedTask = null;
}

function replacePlatformTask(updated) {
  const index = state.tasks.findIndex((task) => task.key === updated.key);
  if (index >= 0) state.tasks[index] = updated;
  else state.tasks.unshift(updated);
}

async function runInitTask(key, button) {
  button.disabled = true;
  try {
    const result = await api(`/api/platform/tasks/${encodeURIComponent(key)}/run`, {
      method: "POST",
      body: JSON.stringify({ agent: "codex" }),
    });
    replacePlatformTask(result.task);
    renderAll();
    openTaskDetail(key);
    toast(result.runtime_created ? "初始化 Agent 已启动" : "初始化 Agent 已继续");
  } catch (error) {
    toast(error.message, "error");
    await loadData({ silent: true });
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function initWorkflowAction(key, action, button, successMessage) {
  const operationKey = `${key}:${action}`;
  if (state.pendingActions.has(operationKey)) return;
  state.pendingActions.add(operationKey);
  button.disabled = true;
  try {
    const result = await api(`/api/platform/tasks/${encodeURIComponent(key)}/${action}`, {
      method: "POST",
      body: "{}",
    });
    const updated = result.task || result;
    replacePlatformTask(updated);
    if (result.repository) {
      const repositoryIndex = state.repositories.findIndex((item) => item.id === result.repository.id);
      if (repositoryIndex >= 0) state.repositories[repositoryIndex] = result.repository;
    }
    renderAll();
    openTaskDetail(key);
    toast(successMessage);
  } catch (error) {
    toast(error.message, "error");
    await loadData({ silent: true });
  } finally {
    state.pendingActions.delete(operationKey);
    if (button.isConnected) button.disabled = false;
    if (state.selectedTask?.key === key && !$("#task-drawer").hidden) openTaskDetail(key);
  }
}

async function setTaskStatus(key, status) {
  try {
    const updated = await api(`/api/platform/tasks/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify({ status }) });
    const index = state.tasks.findIndex((task) => task.key === key);
    if (index >= 0) state.tasks[index] = updated;
    renderAll();
    openTaskDetail(key);
    toast(`${key} 已更新为「${statusLabels[status]}」`);
  } catch (error) { toast(error.message, "error"); }
}

function wireDynamicButtons(root = document) {
  $$('[data-create-task]', root).forEach((button) => button.addEventListener("click", () => openTaskDialog()));
  $$('[data-add-repository]', root).forEach((button) => button.addEventListener("click", openRepositoryDialog));
}

async function loadData({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  try {
    const [repositories, tasks] = await Promise.all([
      api("/api/platform/repositories"),
      api("/api/platform/tasks"),
    ]);
    state.repositories = repositories;
    state.tasks = tasks;
    renderAll();
    const selectedKey = state.selectedTask?.key;
    if (selectedKey && !$("#task-drawer").hidden && state.tasks.some((task) => task.key === selectedKey)) {
      openTaskDetail(selectedKey);
    }
  } catch (error) {
    if (!silent) {
      toast(`无法加载预览数据：${error.message}`, "error");
      $$(".loading-block").forEach((target) => { target.innerHTML = `<div class="empty-state"><div><h3>数据加载失败</h3><p>${escapeHtml(error.message)}</p></div></div>`; });
    }
  } finally { state.loading = false; }
}

function bindEvents() {
  $$(".nav-item[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#mobile-menu").addEventListener("click", openMobileNav);
  $("#mobile-scrim").addEventListener("click", closeMobileNav);
  window.addEventListener("hashchange", () => setView(location.hash.slice(1), { updateHash: false }));
  $$('[data-task-filter]').forEach((button) => button.addEventListener("click", () => {
    state.taskFilter = button.dataset.taskFilter;
    $$('[data-task-filter]').forEach((item) => item.classList.toggle("active", item === button));
    renderTaskList();
  }));
  $("#create-task-form").addEventListener("submit", submitTask);
  $("#add-repository-form").addEventListener("submit", submitRepository);
  $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", closeTaskDialog));
  $$('[data-close-repo-dialog]').forEach((button) => button.addEventListener("click", closeRepositoryDialog));
  $("#create-task-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeTaskDialog(); });
  $("#add-repository-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeRepositoryDialog(); });
  $("#confirm-dialog-cancel").addEventListener("click", () => closeConfirmDialog(false));
  $("#confirm-dialog-submit").addEventListener("click", () => closeConfirmDialog(true));
  $("#confirm-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeConfirmDialog(false); });
  $("#task-drawer").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeTaskDetail(); });
  $("#drawer-close").addEventListener("click", closeTaskDetail);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (isCodeViewOpen()) closeCodeView();
    else if (platformAgentWorkspaceIsOpen()) closePlatformAgentWorkspace();
    else if (!$("#confirm-dialog").hidden) closeConfirmDialog(false);
    else if (!$("#add-repository-dialog").hidden) closeRepositoryDialog();
    else if (!$("#create-task-dialog").hidden) closeTaskDialog();
    else if (!$("#task-drawer").hidden) closeTaskDetail();
  });
  wireDynamicButtons();
  initCodeView();
  initPlatformAgentWorkspace({ onError: (message) => toast(message, "error") });
}

bindEvents();
setView(location.hash.slice(1) || "tasks", { updateHash: false });
loadData();
setInterval(() => {
  if (state.tasks.some((task) => task.task_type === "repository_init" && task.pr_state !== "merged")) {
    loadData({ silent: true });
  }
}, 4000);
