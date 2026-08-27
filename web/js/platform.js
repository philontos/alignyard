import {
  closePlatformAgentWorkspace,
  initPlatformAgentWorkspace,
  openPlatformAgentWorkspace,
  platformAgentWorkspaceIsOpen,
} from "./platform-agent.js";
import { displayGitUrl, formatRepoDate } from "./core/repo-details.js";
import { createRunnerOnboarding } from "./features/runner-onboarding.js";
import {
  closeTaskWorktreeBrowser,
  initTaskWorktreeBrowser,
  openTaskWorktreeBrowser,
  taskWorktreeBrowserIsOpen,
} from "./platform-worktree.js";

const state = {
  view: "tasks",
  tasks: [],
  repositories: [],
  members: [],
  authConfig: null,
  currentUser: null,
  taskFilter: "all",
  selectedTask: null,
  pendingActions: new Set(),
  loading: false,
};

const taskBranchRequests = new Map();
const repositoryProtocolChecks = new Map();
let automaticProtocolRefreshActive = false;

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
  if (!response.ok) {
    const error = new Error(body.error || `请求失败 (${response.status})`);
    error.status = response.status;
    if (response.status === 401 && state.authConfig?.mode === "google" && !path.startsWith("/api/auth/")) {
      void showAuthGate();
    }
    throw error;
  }
  return body;
}

function currentUserName() {
  return state.currentUser?.name || state.currentUser?.email || "当前用户";
}

function taskBelongsToCurrentUser(task) {
  if (!state.currentUser) return false;
  return task.owner_user_id != null
    ? Number(task.owner_user_id) === state.currentUser.id
    : task.owner === currentUserName();
}

function taskAssignedToCurrentUser(task) {
  if (!state.currentUser) return false;
  return task.current_assignee_user_id != null
    ? Number(task.current_assignee_user_id) === state.currentUser.id
    : task.current_assignee === currentUserName();
}

const statusLabels = {
  draft: "草稿",
  review: "待审核",
  approved: "已通过",
  completed: "已完成",
};

const protocolStateLabels = {
  uninitialized: "未初始化",
  initializing: "初始化中",
  ready: "已就绪",
  outdated: "可更新",
  invalid: "初始化无效",
};

function isRepositoryLifecycleTask(task) {
  return ["repository_init", "repository_update"].includes(task?.task_type);
}

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

const runnerOnboarding = createRunnerOnboarding({
  api,
  authConfig: () => state.authConfig,
  currentUser: () => state.currentUser,
  toast,
});

function showGlobalLoading(title, detail = "") {
  $("#global-loading-title").textContent = title;
  $("#global-loading-detail").textContent = detail;
  $("#global-loading").hidden = false;
}

function hideGlobalLoading() {
  $("#global-loading").hidden = true;
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

function statusPill(status, task = null) {
  const label = status === "approved" && !isRepositoryLifecycleTask(task)
    ? "可开始实现"
    : statusLabels[status] || status;
  return `<span class="status-pill status-${escapeHtml(status)}"><i></i>${escapeHtml(label)}</span>`;
}

function taskDisplayTitle(task) {
  if (!isRepositoryLifecycleTask(task)) return task.title;
  return task.repositories.find((repository) => repository.mode === "editable")?.name
    || task.title.replace(/^(?:Initialize|Update) Alignyard\s*·\s*/, "");
}

function taskContextHelp(task) {
  if (!isRepositoryLifecycleTask(task) || !task.description) return "";
  const action = task.task_type === "repository_update" ? "更新" : "初始化";
  return `<details class="task-context-help"><summary aria-label="查看${action}说明">?</summary><p role="tooltip">${escapeHtml(task.description)}</p></details>`;
}

function repositoryChips(repositories) {
  if (!repositories?.length) return `<span class="repo-chip"><span>未关联</span></span>`;
  const visible = repositories.slice(0, 3).map((repo) => `<span class="repo-chip ${repo.mode === "reference" ? "reference" : ""}"><i></i><span>${escapeHtml(repo.name)}</span></span>`).join("");
  const more = repositories.length > 3 ? `<span class="repo-chip"><span>+${repositories.length - 3}</span></span>` : "";
  return visible + more;
}

function filteredTasks() {
  const priorities = { review: 0, draft: 1, approved: 2, completed: 3 };
  return state.tasks.filter((task) => {
    if (state.taskFilter === "mine" && !taskBelongsToCurrentUser(task)) return false;
    if (state.taskFilter === "review" && (task.status !== "review" || !taskAssignedToCurrentUser(task))) return false;
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
  target.innerHTML = tasks.map((task) => `<article class="task-row">
    <button class="task-row-open" type="button" data-task-key="${escapeHtml(task.key)}">
      <span class="task-main"><span class="task-key-line"><span class="task-key">${escapeHtml(task.key)}</span>${statusPill(task.status, task)}</span><strong class="task-title">${escapeHtml(taskDisplayTitle(task))}</strong></span>
      <span class="repo-chips">${repositoryChips(task.repositories)}</span>
      <span class="task-owner"><span class="mini-avatar">${escapeHtml(initial(task.current_assignee || task.owner))}</span>${escapeHtml(task.current_assignee || task.owner)}</span>
    </button>
    <button class="button danger small task-row-delete" type="button" data-delete-task-key="${escapeHtml(task.key)}" aria-label="删除 ${escapeHtml(task.key)}">删除</button>
  </article>`).join("");
  $$('[data-task-key]', target).forEach((button) => button.addEventListener("click", () => openTaskDetail(button.dataset.taskKey)));
  $$('[data-delete-task-key]', target).forEach((button) => button.addEventListener("click", () => {
    const task = state.tasks.find((item) => item.key === button.dataset.deleteTaskKey);
    if (task) deletePlatformTask(task, button);
  }));
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
      task.task_type === "repository_init" && task.status !== "completed" &&
      task.repositories.some((item) => item.id === repo.id)
    );
    const updateTask = state.tasks.find((task) =>
      task.task_type === "repository_update" && task.status !== "completed" &&
      task.repositories.some((item) => item.id === repo.id)
    );
    const protocolState = repositoryProtocolState(repo);
    const label = `${protocolStateLabels[protocolState] || protocolState}；点击刷新`;
    const primaryAction = protocolState === "ready"
      ? `<button class="button secondary small" type="button" data-task-from-repo="${repo.id}">＋ Task</button>`
      : protocolState === "outdated"
        ? updateTask
          ? `<button class="button secondary small" type="button" data-task-key="${escapeHtml(updateTask.key)}">${escapeHtml(updateTask.key)}</button>`
          : `<button class="button secondary small" type="button" data-update-repository="${repo.id}">Update</button>`
      : initTask
        ? `<button class="button secondary small" type="button" data-task-key="${escapeHtml(initTask.key)}">${escapeHtml(initTask.key)}</button>`
        : `<button class="button secondary small" type="button" data-init-repository="${repo.id}">Initialize</button>`;
    return `<article class="repository-row">
      <button class="protocol-indicator state-${escapeHtml(protocolState)}" type="button" data-refresh-protocol="${repo.id}" aria-label="${escapeHtml(label)}" title="${escapeHtml(repo.protocol_error || label)}"><i></i></button>
      <button class="repository-main repository-open" type="button" data-open-repository="${repo.id}"><strong>${escapeHtml(repo.name)}</strong><small title="${escapeHtml(repo.git_url)}">${escapeHtml(repo.git_url)}</small><em>${escapeHtml(protocolStateLabels[protocolState] || protocolState)}</em></button>
      <span class="repository-branch">${escapeHtml(repo.default_branch)}</span>
      <span class="repository-task-count">${taskCount} Tasks</span>
      <span class="repository-actions">${primaryAction}<button class="button danger small" type="button" data-delete-repository="${repo.id}">删除</button></span>
    </article>`;
  }).join("");
  $$('[data-task-from-repo]', target).forEach((button) => button.addEventListener("click", () => openTaskDialog(Number(button.dataset.taskFromRepo))));
  $$('[data-open-repository]', target).forEach((button) => button.addEventListener("click", () => openRepositoryDetails(Number(button.dataset.openRepository))));
  $$('[data-task-key]', target).forEach((button) => button.addEventListener("click", () => openTaskDetail(button.dataset.taskKey)));
  $$('[data-init-repository]', target).forEach((button) => button.addEventListener("click", () => initializeRepository(Number(button.dataset.initRepository), button)));
  $$('[data-update-repository]', target).forEach((button) => button.addEventListener("click", () => updateRepository(Number(button.dataset.updateRepository), button)));
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
  if (!$("#task-drawer").hidden) closeTaskDetail();
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

function abortTaskBranchRequests() {
  taskBranchRequests.forEach((controller) => controller.abort());
  taskBranchRequests.clear();
}

async function loadTaskRepositoryBranches(row, repository) {
  const select = $('[data-repository-branch]', row);
  if (!select) return;
  taskBranchRequests.get(repository.id)?.abort();
  const controller = new AbortController();
  taskBranchRequests.set(repository.id, controller);
  const preferred = select.value || repository.default_branch;
  select.disabled = true;
  select.dataset.state = "loading";
  select.innerHTML = '<option value="">正在加载分支…</option>';
  try {
    const branches = await api(`/api/platform/repositories/${repository.id}/branches`, { signal: controller.signal });
    const options = [...new Set((Array.isArray(branches) ? branches : [])
      .map((branch) => String(branch).trim()).filter(Boolean))];
    if (!options.length) throw new Error("没有可用分支");
    const selected = options.includes(preferred)
      ? preferred
      : options.includes(repository.default_branch) ? repository.default_branch : options[0];
    select.innerHTML = options.map((branch) => `<option value="${escapeHtml(branch)}">${escapeHtml(branch)}</option>`).join("");
    select.value = selected;
    select.dataset.state = "ready";
  } catch (error) {
    if (error.name === "AbortError") return;
    select.innerHTML = `<option value="">${escapeHtml(error.message || "分支加载失败")}</option>`;
    select.dataset.state = "error";
  } finally {
    if (taskBranchRequests.get(repository.id) === controller) {
      taskBranchRequests.delete(repository.id);
      if (select.isConnected) select.disabled = false;
    }
  }
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
    return `<label class="repo-option ${selected ? "selected" : ""}" data-repository-id="${repo.id}">
      <input type="checkbox" value="${repo.id}" ${selected ? "checked" : ""} ${ready ? "" : "disabled"} />
      <span><strong>${escapeHtml(repo.name)}</strong><small>${escapeHtml(repo.git_url)} · ${escapeHtml(protocolStateLabels[protocolState] || protocolState)}</small></span>
      <select data-repository-branch data-state="idle" aria-label="${escapeHtml(repo.name)} 基准分支"><option value="${escapeHtml(repo.default_branch)}">${escapeHtml(repo.default_branch)}</option></select>
    </label>`;
  }).join("");
  $$('.repo-option input[type="checkbox"]', target).forEach((checkbox) => checkbox.addEventListener("change", () => {
    const row = checkbox.closest(".repo-option");
    if (checkbox.checked && runnerOnboarding.enabled()) {
      $$('.repo-option input[type="checkbox"]', target).forEach((candidate) => {
        if (candidate === checkbox || !candidate.checked) return;
        candidate.checked = false;
        candidate.closest(".repo-option").classList.remove("selected");
        const previous = state.repositories.find((item) => item.id === Number(candidate.value));
        if (previous) {
          taskBranchRequests.get(previous.id)?.abort();
          taskBranchRequests.delete(previous.id);
        }
      });
    }
    row.classList.toggle("selected", checkbox.checked);
    const repository = state.repositories.find((item) => item.id === Number(checkbox.value));
    if (!repository) return;
    if (checkbox.checked) {
      void loadTaskRepositoryBranches(row, repository);
    } else {
      taskBranchRequests.get(repository.id)?.abort();
      taskBranchRequests.delete(repository.id);
    }
  }));
  $$('.repo-option.selected', target).forEach((row) => {
    const repository = state.repositories.find((item) => item.id === Number(row.dataset.repositoryId));
    if (repository) void loadTaskRepositoryBranches(row, repository);
  });
}

function openTaskDialog(preselectId, defaults = {}) {
  abortTaskBranchRequests();
  const form = $("#create-task-form");
  form.reset();
  form.elements.owner.value = currentUserName();
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
  showGlobalLoading("正在创建初始化 Task…", "正在准备初始化流程，请稍候。");
  try {
    const result = await api(`/api/platform/repositories/${repositoryId}/initialize`, {
      method: "POST",
      body: "{}",
    });
    const taskIndex = state.tasks.findIndex((task) => task.key === result.task.key);
    if (taskIndex >= 0) state.tasks[taskIndex] = result.task;
    else state.tasks.unshift(result.task);
    const repositoryIndex = state.repositories.findIndex((item) => item.id === repositoryId);
    if (repositoryIndex >= 0 && result.repository) state.repositories[repositoryIndex] = result.repository;
    renderAll();
    setView("tasks");
    openTaskDetail(result.task.key);
    toast(`${result.task.key} 已创建，请选择 Agent 启动`);
  } catch (error) {
    toast(error.message, "error");
    await loadData({ silent: true });
  } finally {
    hideGlobalLoading();
    if (button.isConnected) button.disabled = false;
  }
}

async function updateRepository(repositoryId, button) {
  const repository = state.repositories.find((item) => item.id === repositoryId);
  if (!repository) return;
  button.disabled = true;
  showGlobalLoading("正在创建框架更新 Task…", "正在准备 Alignyard 框架更新流程，请稍候。");
  try {
    const result = await api(`/api/platform/repositories/${repositoryId}/update`, {
      method: "POST",
      body: "{}",
    });
    const taskIndex = state.tasks.findIndex((task) => task.key === result.task.key);
    if (taskIndex >= 0) state.tasks[taskIndex] = result.task;
    else state.tasks.unshift(result.task);
    const repositoryIndex = state.repositories.findIndex((item) => item.id === repositoryId);
    if (repositoryIndex >= 0 && result.repository) state.repositories[repositoryIndex] = result.repository;
    renderAll();
    setView("tasks");
    openTaskDetail(result.task.key);
    toast(`${result.task.key} 已创建，请选择 Agent 启动`);
  } catch (error) {
    toast(error.message, "error");
    await loadData({ silent: true });
  } finally {
    hideGlobalLoading();
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
  showGlobalLoading("正在删除 Repository…", "正在清理本机 clone 和平台元数据，请稍候。");
  try {
    await api(`/api/platform/repositories/${repositoryId}`, { method: "DELETE" });
    state.repositories = state.repositories.filter((item) => item.id !== repositoryId);
    renderAll();
    toast(`${repository.name} 已删除`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    hideGlobalLoading();
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
    message: `确定要删除「${task.key} · ${taskDisplayTitle(task)}」吗？`,
    detail: `关联的 Agent session、worktree 和本地 runtime Task 都会清理。${remoteDetail}`,
    confirmText: "删除 Task",
  });
  if (!confirmed) return;
  button.disabled = true;
  showGlobalLoading("正在删除 Task…", "正在关闭合并请求并清理 Agent、worktree 与本地记录，请稍候。");
  try {
    await api(`/api/platform/tasks/${encodeURIComponent(task.key)}`, { method: "DELETE" });
    state.tasks = state.tasks.filter((item) => item.key !== task.key);
    if (task.task_type === "repository_init" && task.pr_state !== "merged") {
      const repositoryIds = new Set(task.repositories.map((item) => item.id));
      state.repositories = state.repositories.map((repository) => repositoryIds.has(repository.id)
        ? { ...repository, protocol_initialized: false, protocol_state: "uninitialized", protocol_error: null }
        : repository);
    }
    closeTaskDetail();
    renderAll();
    await loadData({ silent: true });
    toast(`${task.key} 已删除`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    hideGlobalLoading();
    if (button.isConnected) button.disabled = false;
  }
}

function closeTaskDialog() {
  abortTaskBranchRequests();
  $("#create-task-dialog").hidden = true;
}
function closeReviewDialog() { $("#review-dialog").hidden = true; }
function closeChangesRequestedDialog() { $("#changes-requested-dialog").hidden = true; }
function openChangesRequestedDialog(task) {
  const form = $("#changes-requested-form");
  form.reset();
  form.elements.task_key.value = task.key;
  $("#changes-requested-error").textContent = "";
  $("#changes-requested-dialog").hidden = false;
  setTimeout(() => form.elements.feedback.focus(), 0);
}
function openReviewDialog(task) {
  const form = $("#review-form");
  form.reset();
  form.elements.task_key.value = task.key;
  $("#review-form-error").textContent = "";
  form.elements.reviewer_user_id.innerHTML = state.members.map((member) => {
    const label = member.email && member.email !== member.name
      ? `${member.name} · ${member.email}`
      : member.name;
    return `<option value="${member.id}" ${member.id === state.currentUser?.id ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  $("#review-dialog").hidden = false;
  setTimeout(() => form.elements.reviewer_user_id.focus(), 0);
}

async function submitReview(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const key = form.elements.task_key.value;
  const reviewerUserId = Number(form.elements.reviewer_user_id.value);
  const reviewer = state.members.find((member) => member.id === reviewerUserId);
  const submit = $("#review-submit");
  submit.disabled = true;
  $("#review-form-error").textContent = "";
  showGlobalLoading("正在提交 Review…", "正在检查提交与 sync、推送远端工作分支并完成 reviewer 分派，请稍候。");
  try {
    const updated = await api(`/api/platform/tasks/${encodeURIComponent(key)}/review`, {
      method: "POST",
      body: JSON.stringify({ reviewer_user_id: reviewerUserId }),
    });
    replacePlatformTask(updated);
    closeReviewDialog();
    renderAll();
    closeTaskDetail();
    toast(`已分派给 ${reviewer?.name || "Reviewer"}，等待对方打开 Task`);
  } catch (error) {
    $("#review-form-error").textContent = error.message;
  } finally {
    hideGlobalLoading();
    submit.disabled = false;
  }
}

async function submitChangesRequested(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const task = state.tasks.find((item) => item.key === form.elements.task_key.value);
  const feedback = form.elements.feedback.value.trim();
  if (!task || !feedback) {
    $("#changes-requested-error").textContent = feedback ? "Task 不存在" : "请填写需要修改的内容";
    return;
  }
  const submitted = await decideReview(task, "changes_requested", $("#changes-requested-submit"), feedback);
  if (submitted) closeChangesRequestedDialog();
}

function openRepositoryDialog() {
  const form = $("#add-repository-form");
  form.reset();
  $("#repo-form-error").textContent = "";
  $("#add-repository-dialog").hidden = false;
  setTimeout(() => form.elements.name.focus(), 0);
}
function closeRepositoryDialog() { $("#add-repository-dialog").hidden = true; }

let repositoryDetailPreviousFocus = null;

function repositoryForgeLabel(kind) {
  if (kind === "github") return "GitHub";
  if (kind === "gitlab") return "GitLab";
  return "Git";
}

function openRepositoryDetails(repositoryId) {
  const repository = state.repositories.find((item) => item.id === repositoryId);
  if (!repository) return;
  const protocolState = repositoryProtocolState(repository);
  const taskCount = state.tasks.filter((task) => task.repositories.some((item) => item.id === repository.id)).length;
  repositoryDetailPreviousFocus = document.activeElement;
  $("#repository-detail-id").textContent = `#${repository.id}`;
  $("#repository-detail-name").textContent = repository.name;
  $("#repository-detail-forge").textContent = repositoryForgeLabel(repository.forge_kind);
  $("#repository-detail-url").textContent = displayGitUrl(repository.git_url) || "—";
  $("#repository-detail-branch").textContent = repository.default_branch || "—";
  $("#repository-detail-status").textContent = protocolStateLabels[protocolState] || protocolState;
  $("#repository-detail-status").className = `repository-detail-status state-${protocolState}`;
  $("#repository-detail-tasks").textContent = String(taskCount);
  $("#repository-detail-creator").textContent = repository.created_by || "—";
  $("#repository-detail-created").textContent = formatRepoDate(repository.created_at, "zh") || "—";
  $("#repository-detail-updated").textContent = formatRepoDate(repository.updated_at, "zh") || "—";
  const error = $("#repository-detail-error");
  error.textContent = repository.protocol_error || "";
  error.hidden = !repository.protocol_error;
  $("#repository-detail-dialog").hidden = false;
  setTimeout(() => $("#repository-detail-close").focus(), 0);
}

function closeRepositoryDetails() {
  const dialog = $("#repository-detail-dialog");
  if (dialog.hidden) return;
  dialog.hidden = true;
  const previousFocus = repositoryDetailPreviousFocus;
  repositoryDetailPreviousFocus = null;
  if (previousFocus?.isConnected) previousFocus.focus();
}

async function submitTask(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const selectedRows = $$(".repo-option", form).filter((row) => $('input[type="checkbox"]', row).checked);
  if (runnerOnboarding.enabled() && selectedRows.length !== 1) {
    $("#task-form-error").textContent = "请选择一个 Repository";
    return;
  }
  if (selectedRows.some((row) => $('[data-repository-branch]', row).dataset.state === "loading")) {
    $("#task-form-error").textContent = "正在加载分支，请稍候";
    return;
  }
  if (selectedRows.some((row) => !$('[data-repository-branch]', row).value)) {
    $("#task-form-error").textContent = "请选择有效的基准分支";
    return;
  }
  const repositories = selectedRows.map((row) => ({
    repository_id: Number($('input[type="checkbox"]', row).value),
    mode: "editable",
    base_branch: $('[data-repository-branch]', row).value,
  }));
  const payload = {
    title: form.elements.title.value.trim(),
    description: form.elements.description.value.trim(),
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
  };
  const submit = $("#add-repository-submit");
  submit.disabled = true;
  submit.textContent = "添加中…";
  $("#repo-form-error").textContent = "";
  try {
    if (!localPayload.default_branch) localPayload.default_branch = "main";
    let repository;
    if (!runnerOnboarding.enabled()) {
      const localResult = await api("/api/repos", { method: "POST", body: JSON.stringify(localPayload) });
      const localRepositories = await api("/api/repos");
      const localRepository = localRepositories.find((item) => item.id === localResult.id);
      if (!localRepository) throw new Error("本地 Repository 添加后未找到");
      localPayload.default_branch = localRepository.default_branch;
    }
    try {
      repository = await api("/api/platform/repositories", { method: "POST", body: JSON.stringify(localPayload) });
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

async function refreshRepositoryProtocolsAutomatically() {
  if (automaticProtocolRefreshActive || !state.currentUser || !state.repositories.length) return;
  const now = Date.now();
  const repositories = state.repositories.filter((repository) =>
    now >= (repositoryProtocolChecks.get(repository.id) || 0)
  );
  if (!repositories.length) return;
  automaticProtocolRefreshActive = true;
  repositories.forEach((repository) => repositoryProtocolChecks.set(repository.id, now + 30_000));
  let changed = false;
  await Promise.all(repositories.map(async (repository) => {
    try {
      const refreshed = await api(`/api/platform/repositories/${repository.id}/refresh`, { method: "POST" });
      const index = state.repositories.findIndex((item) => item.id === repository.id);
      if (index >= 0) {
        state.repositories[index] = refreshed;
        changed = true;
      }
      repositoryProtocolChecks.set(repository.id, Date.now() + 5 * 60_000);
    } catch {
      // Runner may still be connecting. The short retry window above keeps this
      // automatic without turning a missing local Runner into a visible error.
    }
  }));
  automaticProtocolRefreshActive = false;
  if (changed) renderRepositories();
}

function knowledgeKind(kind) {
  const normalized = String(kind || "docs").toLowerCase();
  if (normalized === "adr") return "adr";
  if (normalized === "spec" || normalized === "specs") return "specs";
  if (normalized === "plan" || normalized === "plans") return "plans";
  return "docs";
}

async function loadWorktreeKnowledge(task) {
  const target = $("#worktree-knowledge");
  if (!target) return;
  const taskKey = task.key;
  target.innerHTML = `<div class="detail-empty">正在从当前 Runner worktree 解析 .alignyard/…</div>`;
  try {
    const result = await api(`/api/platform/tasks/${encodeURIComponent(task.key)}/knowledge`);
    if (state.selectedTask?.key !== taskKey || target !== $("#worktree-knowledge")) return;
    if (!result.documents.length) {
      target.innerHTML = `<div class="detail-empty">当前 worktree 中还没有符合 .alignyard/ 协议的工程文档。</div>`;
      return;
    }
    target.innerHTML = `<div class="worktree-knowledge-list">${result.documents.map((document) => `<button type="button" class="worktree-knowledge-row" data-knowledge-path="${escapeHtml(document.path)}"><span class="artifact-kind ${knowledgeKind(document.kind)}">${escapeHtml(knowledgeKind(document.kind).slice(0, 4))}</span><span><strong>${escapeHtml(document.title)}</strong><small>${escapeHtml(document.path)}</small></span><i aria-hidden="true">›</i></button>`).join("")}</div>`;
    $$('[data-knowledge-path]', target).forEach((item) => item.addEventListener("click", () => openTaskWorktreeBrowser(task, { path: item.dataset.knowledgePath })));
  } catch (error) {
    if (state.selectedTask?.key !== taskKey || target !== $("#worktree-knowledge")) return;
    target.innerHTML = `<div class="detail-empty error">${escapeHtml(error.message)}</div>`;
  }
}

function detailRepository(repo) {
  const design = repo.design_commit
    ? `设计基线 ${String(repo.design_commit).slice(0, 10)}`
    : repo.work_branch || "工作分支尚未创建";
  return `<article class="detail-repo"><div><strong>${escapeHtml(repo.name)}</strong><small>${escapeHtml(repo.git_url)}</small></div><div><strong>${escapeHtml(repo.base_branch)}</strong><small>${escapeHtml(design)}</small></div></article>`;
}

function taskChangeRequestLabel(task) {
  const repository = task.repositories.find((item) => item.mode === "editable");
  return repository?.forge_kind === "github" ? "PR" : repository?.forge_kind === "gitlab" ? "MR" : "合并请求";
}

function pendingAction(task, action) {
  return state.pendingActions.has(`${task.key}:${action}`);
}

function taskNextAction(task) {
  return initTaskActions(task);
}

function initWorkflowStage(task) {
  const repository = task.repositories.find((item) => item.mode === "editable");
  const requestLabel = taskChangeRequestLabel(task);
  const action = task.task_type === "repository_update" ? "更新" : "初始化";
  if (task.pr_state === "merged" && repository?.protocol_state === "ready") {
    const note = task.workflow_error
      ? `Repository 已完成${action}；本地清理提示：${task.workflow_error}`
      : `${requestLabel} 已合并，Repository 已完成${action}。`;
    return { key: "merged", label: "已合并", note };
  }
  if (task.workflow_error || task.runtime_error) return { key: "error", label: "需要处理", note: task.workflow_error || task.runtime_error };
  if (task.pr_state === "merged") return { key: "error", label: `等待完成${action}`, note: `${requestLabel} 已合并，正在确认默认分支上的 Alignyard 文件。` };
  if (task.status === "approved" && task.pr_state === "open") return { key: "pr", label: `${requestLabel} 待合并`, note: `Review 已批准，${requestLabel} 已创建，等待人工确认合并。` };
  if (task.status === "approved") return { key: "approved", label: "Review 已通过", note: `平台状态已流转完成；确认后可单独创建 ${requestLabel}。` };
  if (task.status === "review") return { key: "review", label: "等待 Review", note: `工作分支已推送并分派给 ${task.review?.reviewer || task.current_assignee || "reviewer"}。` };
  if (task.status === "draft" && task.pr_state === "open") return { key: "paused", label: "要求修改", note: `${requestLabel} 保持打开；继续 Agent 修改后重新提交 Review。` };
  if (task.runtime_task_id && task.runtime_alive) return { key: "running", label: "Agent 执行中", note: "Agent 正在 worktree 中编撰工程文档；是否提交 Review 由你和 Agent 判断。" };
  if (task.runtime_task_id) return { key: "ready", label: "等待你的判断", note: "worktree 已保留；可以继续 Agent、按需读取文档，或提交 Review。" };
  return { key: "waiting", label: "等待启动", note: "启动后平台会自动创建 worktree、工作分支和 Agent session。" };
}

function initWorkflowPanel(task) {
  const stage = initWorkflowStage(task);
  const requestLabel = taskChangeRequestLabel(task);
  const updating = task.task_type === "repository_update";
  const stepState = (name) => {
    const order = ["waiting", "running", "paused", "error", "ready", "review", "approved", "pr", "merged"];
    const positions = { agent: 1, review: 5, pr: 7, merge: 8 };
    const current = order.indexOf(stage.key);
    const target = positions[name];
    if (name === "agent" && current >= 1 && current <= 3) return "active";
    return current > target ? "done" : current === target ? "active" : "pending";
  };
  return `<section class="init-workflow state-${escapeHtml(stage.key)}">
    <div class="init-workflow-head"><div><span>${updating ? "FRAMEWORK UPDATE" : "REPOSITORY INIT"}</span><strong>${escapeHtml(stage.label)}</strong></div><i></i></div>
    <p>${escapeHtml(stage.note || "")}</p>
    <ol class="workflow-steps">
      <li class="${stepState("agent")}"><i>1</i><span>Agent ${updating ? "更新" : "初始化"}</span></li>
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
    actions.push(`<button class="button secondary mobile-agent-action" type="button" data-open-agent>打开 Agent</button>`);
  }
  if (task.status === "draft" && (!task.runtime_task_id || !task.runtime_has_worktree)) {
    actions.push(`<div class="task-agent-launch"><div class="agent-picker" data-agent-picker><input type="hidden" data-author-agent value="codex"><button class="agent-picker-trigger" type="button" data-agent-picker-trigger aria-haspopup="listbox" aria-expanded="false"><span data-agent-picker-label>Codex</span><i aria-hidden="true"></i></button><div class="agent-picker-menu" data-agent-picker-menu role="listbox" aria-label="选择 Agent" hidden><button class="selected" type="button" role="option" aria-selected="true" data-agent-value="codex"><span>Codex</span><i aria-hidden="true">✓</i></button><button type="button" role="option" aria-selected="false" data-agent-value="claude"><span>Claude Code</span><i aria-hidden="true">✓</i></button><button type="button" role="option" aria-selected="false" data-agent-value="kimi"><span>Kimi CLI</span><i aria-hidden="true">✓</i></button></div></div><button class="button primary" type="button" data-run-init>启动 Agent</button></div>`);
  } else if (task.status === "draft") {
    if (!task.runtime_alive) actions.push(`<button class="button secondary" type="button" data-run-init>继续 Agent</button>`);
    actions.push(`<button class="button primary" type="button" data-init-review>提交 Review</button>`);
  } else if (task.status === "review") {
    actions.push(`<button class="button secondary" type="button" data-review-decision="changes_requested">要求修改</button>`);
    actions.push(`<button class="button primary" type="button" data-review-decision="approved">审核通过</button>`);
  } else if (task.status === "approved" && !isRepositoryLifecycleTask(task)) {
    const repository = task.repositories.find((item) => item.mode === "editable");
    const commit = repository?.design_commit ? String(repository.design_commit).slice(0, 10) : "已审核提交";
    actions.push(`<div class="design-ready"><strong>设计已确认，可以开始实现</strong><span>继续使用远端工作分支；设计基线 ${escapeHtml(commit)}。</span></div>`);
  } else if (task.status === "approved" && task.pr_state === "none" && taskBelongsToCurrentUser(task)) {
    actions.push(`<button class="button primary" type="button" data-init-pr ${pendingAction(task, "pull-request") ? "disabled" : ""}>${pendingAction(task, "pull-request") ? `正在创建 ${requestLabel}…` : `创建 ${requestLabel}`}</button>`);
  } else if (task.status === "approved" && task.pr_state === "open" && taskBelongsToCurrentUser(task)) {
    actions.push(`<a class="button secondary link" href="${escapeHtml(task.pr_url)}" target="_blank" rel="noreferrer">查看 ${requestLabel} #${task.pr_number}</a>`);
    const confirming = pendingAction(task, "refresh-change-request");
    actions.push(`<button class="button primary" type="button" data-init-merge ${pendingAction(task, "merge") || confirming ? "disabled" : ""}>${confirming ? `正在确认 ${requestLabel} 状态…` : pendingAction(task, "merge") ? `正在合并 ${requestLabel}…` : `合并 ${requestLabel}`}</button>`);
  } else if (task.status === "approved" && task.pr_state === "merged" && repository?.protocol_state !== "ready") {
    actions.push(`<a class="button secondary link" href="${escapeHtml(task.pr_url)}" target="_blank" rel="noreferrer">查看 ${requestLabel} #${task.pr_number}</a>`);
    actions.push(`<button class="button primary" type="button" data-init-merge>重试完成${task.task_type === "repository_update" ? "更新" : "初始化"}</button>`);
  } else if (task.pr_url) {
    actions.push(`<a class="button secondary link" href="${escapeHtml(task.pr_url)}" target="_blank" rel="noreferrer">查看 ${requestLabel} #${task.pr_number}</a>`);
  }
  return actions.join("");
}

function closeAgentPicker(picker) {
  const menu = $("[data-agent-picker-menu]", picker);
  const trigger = $("[data-agent-picker-trigger]", picker);
  if (menu) menu.hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
}

function wireAgentPicker(root) {
  const picker = $("[data-agent-picker]", root);
  if (!picker) return;
  const trigger = $("[data-agent-picker-trigger]", picker);
  const menu = $("[data-agent-picker-menu]", picker);
  const input = $("[data-author-agent]", picker);
  const label = $("[data-agent-picker-label]", picker);
  trigger.addEventListener("click", () => {
    const willOpen = menu.hidden;
    $$('[data-agent-picker]').forEach((item) => closeAgentPicker(item));
    menu.hidden = !willOpen;
    trigger.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) $("[aria-selected='true']", menu)?.focus();
  });
  $$('[data-agent-value]', menu).forEach((option) => option.addEventListener("click", () => {
    input.value = option.dataset.agentValue;
    label.textContent = option.querySelector("span").textContent;
    $$('[data-agent-value]', menu).forEach((item) => {
      const selected = item === option;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-selected", String(selected));
    });
    closeAgentPicker(picker);
    trigger.focus();
  }));
}

function taskLocalCommands(task) {
  if (task.task_type === "repository_init") {
    return ["ay init .", "ay new doc overview --scope shared --title \"仓库概览\"", "ay validate ."];
  }
  if (task.task_type === "repository_update") {
    return ["ay update --check .", "ay update .", "ay validate ."];
  }
  return ["ay validate ."];
}

function openTaskDetail(key, { refreshChangeRequest = null } = {}) {
  const task = state.tasks.find((item) => item.key === key);
  if (!task) return;
  const shouldRefreshChangeRequest = refreshChangeRequest == null
    ? state.selectedTask?.key !== key || $("#task-drawer").hidden
    : refreshChangeRequest;
  if (shouldRefreshChangeRequest && task.pr_number && task.pr_state === "open") {
    state.pendingActions.add(`${key}:refresh-change-request`);
  }
  state.selectedTask = task;
  const commands = taskLocalCommands(task);
  const commandList = commands.map((command, index) => `<div class="detail-command"><span>${escapeHtml(command)}</span><button type="button" data-copy-command="${index}">复制</button></div>`).join("");
  const workflowNote = isRepositoryLifecycleTask(task)
    ? `${initWorkflowPanel(task)}<details class="manual-workflow"><summary>手动模式与诊断命令</summary><p>自动 Agent 无法完成时，才需要在保留的 worktree 中执行这些命令。</p>${commandList}</details>`
    : "";
  const reviewFeedback = task.review?.feedback ? `<p><strong>Review 反馈：</strong>${escapeHtml(task.review.feedback)}</p>` : "";
  const reviewSummary = task.review?.status === "changes_requested"
    ? `Reviewer 已要求修改，Task 已退回 ${escapeHtml(task.owner)}。继续 Agent 时会恢复 Author 工作区并传入本轮反馈。`
    : `由 ${escapeHtml(task.review?.submitted_by || "")} 于 ${escapeHtml(formatDate(task.review?.submitted_at))} 分派；当前状态：${escapeHtml(task.review?.status || "")}。工作分支已推送到远端，reviewer 可在右侧选择 Agent 进入对应 worktree。`;
  const reviewHandoff = task.review ? `<section class="detail-workflow"><strong>Review · ${escapeHtml(task.review.reviewer)}</strong><p>${reviewSummary}</p>${reviewFeedback}</section>` : "";
  const displayTitle = taskDisplayTitle(task);
  const description = isRepositoryLifecycleTask(task)
    ? ""
    : `<p>${escapeHtml(task.description || "尚未填写需求说明")}</p>`;
  const workspaceTask = { ...task, display_title: displayTitle };
  $("#task-detail").innerHTML = `<div class="detail-top"><div class="detail-title-row"><button class="drawer-close" id="drawer-close" type="button" aria-label="返回 Task 列表">返回</button><span class="task-key">${escapeHtml(task.key)}</span><h1>${escapeHtml(displayTitle)}</h1>${taskContextHelp(task)}</div>${description}</div>
    <div class="detail-meta">${statusPill(task.status, task)}<span>负责人：${escapeHtml(task.owner)}</span><span>当前处理人：${escapeHtml(task.current_assignee || task.owner)}</span><span>${task.completed_at ? `完成于 ${escapeHtml(formatDate(task.completed_at))}` : `创建于 ${escapeHtml(formatDate(task.created_at))}`}</span></div>
    ${workflowNote}${reviewHandoff}${isRepositoryLifecycleTask(task) ? "" : commandList}
    <section class="detail-section"><div class="detail-section-head"><h2>Repositories · ${task.repositories.length}</h2><span class="protocol-badge">peer worktrees</span></div><div class="detail-repos">${task.repositories.map(detailRepository).join("")}</div></section>
    <section class="detail-section"><div class="detail-section-head"><h2>工程文档</h2>${task.runtime_task_id && task.runtime_has_worktree ? `<button class="text-button review-changes" type="button" data-open-worktree-changes>查看变更</button>` : ""}</div><p class="detail-section-note">Platform 通过你的 Runner 自动解析当前 worktree 中的 .alignyard/；点击文档进入完整 worktree 浏览页。</p><div id="worktree-knowledge"><div class="detail-empty">${task.runtime_task_id && task.runtime_has_worktree ? "正在从当前 Runner worktree 解析 .alignyard/…" : "启动 Agent 后，这里会自动展示对应 worktree 中的工程文档。"}</div></div></section>
    <div class="detail-actions">${taskNextAction(task)}</div>`;
  $("#task-drawer").hidden = false;
  $("#drawer-close").addEventListener("click", closeTaskDetail);
  const contextHelp = $(".task-context-help", $("#task-detail"));
  contextHelp?.addEventListener("mouseleave", () => {
    contextHelp.removeAttribute("open");
    $("summary", contextHelp)?.blur();
  });
  wireAgentPicker($("#task-detail"));
  $$('[data-copy-command]', $("#task-detail")).forEach((button) => button.addEventListener("click", () => copyCommand(commands[Number(button.dataset.copyCommand)])));
  if (task.runtime_task_id && task.runtime_has_worktree) void loadWorktreeKnowledge(workspaceTask);
  $('[data-open-worktree-changes]', $("#task-detail"))?.addEventListener("click", () => openTaskWorktreeBrowser(workspaceTask, { tab: "changes" }));
  $$('[data-set-status]', $("#task-detail")).forEach((button) => button.addEventListener("click", () => setTaskStatus(task.key, button.dataset.setStatus)));
  $$('[data-submit-review]', $("#task-detail")).forEach((button) => button.addEventListener("click", () => openReviewDialog(task)));
  $$('[data-review-decision]', $("#task-detail")).forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.reviewDecision === "changes_requested") openChangesRequestedDialog(task);
    else decideReview(task, button.dataset.reviewDecision, button);
  }));
  $('[data-run-init]', $("#task-detail"))?.addEventListener("click", (event) => runInitTask(task.key, event.currentTarget));
  $('[data-open-agent]', $("#task-detail"))?.addEventListener("click", () => openPlatformAgentWorkspace(workspaceTask));
  $('[data-init-review]', $("#task-detail"))?.addEventListener("click", () => openReviewDialog(task));
  const requestLabel = taskChangeRequestLabel(task);
  $('[data-init-pr]', $("#task-detail"))?.addEventListener("click", (event) => initWorkflowAction(task.key, "pull-request", event.currentTarget, `${requestLabel} 已创建`));
  $('[data-init-merge]', $("#task-detail"))?.addEventListener("click", (event) => initWorkflowAction(task.key, "merge", event.currentTarget, `${requestLabel} 已合并，Repository 已就绪`));
  if (!matchMedia("(max-width: 760px)").matches || platformAgentWorkspaceIsOpen()) {
    openPlatformAgentWorkspace(workspaceTask);
  }
  if (shouldRefreshChangeRequest && task.pr_number && task.pr_state === "open") {
    void refreshTaskChangeRequest(key, task.pr_state);
  }
}

function closeTaskDetail() {
  if (taskWorktreeBrowserIsOpen()) closeTaskWorktreeBrowser();
  if (platformAgentWorkspaceIsOpen()) closePlatformAgentWorkspace();
  $("#task-drawer").hidden = true;
  state.selectedTask = null;
}

function replacePlatformTask(updated) {
  const index = state.tasks.findIndex((task) => task.key === updated.key);
  if (index >= 0) state.tasks[index] = updated;
  else state.tasks.unshift(updated);
}

async function refreshTaskChangeRequest(key, previousState) {
  const operationKey = `${key}:refresh-change-request`;
  let result = null;
  try {
    result = await api(`/api/platform/tasks/${encodeURIComponent(key)}/change-request/refresh`, {
      method: "POST",
      body: "{}",
    });
    replacePlatformTask(result.task);
    if (result.repository) {
      const repositoryIndex = state.repositories.findIndex((item) => item.id === result.repository.id);
      if (repositoryIndex >= 0) state.repositories[repositoryIndex] = result.repository;
    }
  } catch (error) {
    // Opening a Task must remain usable when gh/glab or the forge is briefly
    // unavailable. The explicit merge action stays available for a retry.
    console.warn(`无法确认 ${key} 的远端合并请求状态`, error);
  } finally {
    state.pendingActions.delete(operationKey);
    renderAll();
    if (state.selectedTask?.key === key && !$("#task-drawer").hidden) {
      openTaskDetail(key, { refreshChangeRequest: false });
    }
  }
  if (result?.task?.pr_state && result.task.pr_state !== previousState) {
    const requestLabel = taskChangeRequestLabel(result.task);
    const message = result.task.pr_state === "merged"
      ? `${requestLabel} 已在远端合并，平台状态已同步`
      : `${requestLabel} 已在远端关闭，平台状态已同步`;
    toast(message);
  }
}

async function runInitTask(key, button) {
  const agent = button.closest(".task-agent-launch")?.querySelector("[data-author-agent]")?.value || "codex";
  button.disabled = true;
  showGlobalLoading("正在准备 Agent…", "正在创建或恢复 worktree 和 Agent session，请稍候。");
  try {
    const result = await api(`/api/platform/tasks/${encodeURIComponent(key)}/run`, {
      method: "POST",
      body: JSON.stringify({ agent }),
    });
    replacePlatformTask(result.task);
    renderAll();
    openTaskDetail(key);
    toast(result.runtime_created ? "初始化 Agent 已启动" : "初始化 Agent 已继续");
  } catch (error) {
    toast(error.message, "error");
    await loadData({ silent: true });
  } finally {
    hideGlobalLoading();
    if (button.isConnected) button.disabled = false;
  }
}

async function startReviewAgent(task, agent) {
  showGlobalLoading("正在打开 Review 工作区…", "正在从远端工作分支准备 reviewer worktree 并启动所选 Agent，请稍候。");
  try {
    const result = await api(`/api/platform/tasks/${encodeURIComponent(task.key)}/review/run`, {
      method: "POST",
      body: JSON.stringify({ agent }),
    });
    replacePlatformTask(result.task);
    renderAll();
    openTaskDetail(task.key);
    toast(result.runtime_created ? "Review Agent 已启动" : "Review Agent 已继续");
  } finally {
    hideGlobalLoading();
  }
}

async function decideReview(task, decision, button, feedback = null) {
  button.disabled = true;
  const approved = decision === "approved";
  showGlobalLoading(approved ? "正在确认 Review…" : "正在退回修改…", approved
    ? "正在停止 Review Agent 并流转平台状态。"
    : "正在清理 reviewer worktree 并将 Task 重新分派给负责人。");
  try {
    const updated = await api(`/api/platform/tasks/${encodeURIComponent(task.key)}/review/decision`, {
      method: "POST",
      body: JSON.stringify({ decision, feedback }),
    });
    replacePlatformTask(updated);
    renderAll();
    // Every Review decision ends the current actor's workspace. Creating a
    // PR/MR is a separate Author action after they reopen the approved Task.
    closeTaskDetail();
    toast(approved ? "Review 已通过，Task 已交还发起人" : "已要求修改，Task 已交还发起人");
    return true;
  } catch (error) {
    if (!approved && !$("#changes-requested-dialog").hidden) $("#changes-requested-error").textContent = error.message;
    else toast(error.message, "error");
    await loadData({ silent: true });
    return false;
  } finally {
    hideGlobalLoading();
    if (button.isConnected) button.disabled = false;
  }
}

async function initWorkflowAction(key, action, button, successMessage) {
  const operationKey = `${key}:${action}`;
  if (state.pendingActions.has(operationKey)) return;
  state.pendingActions.add(operationKey);
  button.disabled = true;
  const requestLabel = taskChangeRequestLabel(state.tasks.find((task) => task.key === key) || { repositories: [] });
  showGlobalLoading(action === "merge" ? `正在合并 ${requestLabel}…` : `正在创建 ${requestLabel}…`, "正在调用本机 Git 与 forge CLI，请稍候。");
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
    hideGlobalLoading();
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
    const [repositories, tasks, members, runners] = await Promise.all([
      api("/api/platform/repositories"),
      api("/api/platform/tasks"),
      api("/api/platform/members"),
      runnerOnboarding.enabled() ? api("/api/runners") : Promise.resolve([]),
    ]);
    state.repositories = repositories;
    state.tasks = tasks;
    state.members = members;
    renderAll();
    runnerOnboarding.setRunners(runners);
    void refreshRepositoryProtocolsAutomatically();
    const selectedKey = state.selectedTask?.key;
    if (selectedKey && !$("#task-drawer").hidden && state.tasks.some((task) => task.key === selectedKey)) {
      openTaskDetail(selectedKey, { refreshChangeRequest: false });
    }
  } catch (error) {
    if (!silent) {
      toast(`无法加载预览数据：${error.message}`, "error");
      $$(".loading-block").forEach((target) => { target.innerHTML = `<div class="empty-state"><div><h3>数据加载失败</h3><p>${escapeHtml(error.message)}</p></div></div>`; });
    }
  } finally { state.loading = false; }
}

let googleIdentityPromise = null;

function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  if (googleIdentityPromise) return googleIdentityPromise;
  googleIdentityPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => reject(new Error("Google 登录组件加载失败，请检查网络后重试"));
    document.head.append(script);
  });
  return googleIdentityPromise;
}

function renderCurrentUser() {
  const user = state.currentUser;
  if (!user) return;
  $("#top-user").title = user.email ? `${user.name} · ${user.email}` : user.name;
  $("#top-user-initial").textContent = initial(user.name || user.email);
  const image = $("#top-user-image");
  if (user.avatar_url) {
    image.src = user.avatar_url;
    image.hidden = false;
    $("#top-user-initial").hidden = true;
  } else {
    image.removeAttribute("src");
    image.hidden = true;
    $("#top-user-initial").hidden = false;
  }
  $("#account-name").textContent = user.name;
  $("#account-email").textContent = user.email || "";
  $("#account-mode").textContent = state.authConfig?.mode === "google" ? "Google 账号" : "本地调试身份";
  $("#logout-button").hidden = state.authConfig?.mode !== "google";
}

function hideAuthGate() {
  $("#auth-gate").hidden = true;
  $(".app-shell").removeAttribute("aria-hidden");
}

async function handleGoogleCredential(response) {
  $("#auth-error").textContent = "";
  showGlobalLoading("正在登录…", "正在验证 Google 身份并创建本地会话。");
  try {
    state.currentUser = await api("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential: response?.credential }),
    });
    hideAuthGate();
    renderCurrentUser();
    await loadData();
  } catch (error) {
    $("#auth-error").textContent = error.message;
  } finally {
    hideGlobalLoading();
  }
}

async function showAuthGate(message = "") {
  $("#auth-gate").hidden = false;
  $(".app-shell").setAttribute("aria-hidden", "true");
  $("#auth-error").textContent = message;
  if (state.authConfig?.mode !== "google" || !state.authConfig.google_client_id) return;
  try {
    const google = await loadGoogleIdentity();
    google.accounts.id.initialize({
      client_id: state.authConfig.google_client_id,
      callback: handleGoogleCredential,
      cancel_on_tap_outside: false,
    });
    const target = $("#google-signin-button");
    target.innerHTML = "";
    google.accounts.id.renderButton(target, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "signin_with",
      shape: "rectangular",
      width: Math.min(320, window.innerWidth - 80),
    });
  } catch (error) {
    $("#auth-error").textContent = error.message;
  }
}

async function initializeAuthentication() {
  try {
    state.authConfig = await api("/api/auth/config");
    state.currentUser = await api("/api/auth/me");
    renderCurrentUser();
    hideAuthGate();
    return true;
  } catch (error) {
    await showAuthGate(error.status === 401 ? "" : error.message);
    return false;
  }
}

async function logout() {
  $("#account-menu").hidden = true;
  $("#top-user").setAttribute("aria-expanded", "false");
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } finally {
    state.currentUser = null;
    window.google?.accounts?.id?.disableAutoSelect?.();
    await showAuthGate();
  }
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
  runnerOnboarding.bind();
  $("#review-form").addEventListener("submit", submitReview);
  $("#changes-requested-form").addEventListener("submit", submitChangesRequested);
  $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", closeTaskDialog));
  $$('[data-close-repo-dialog]').forEach((button) => button.addEventListener("click", closeRepositoryDialog));
  $("#repository-detail-close").addEventListener("click", closeRepositoryDetails);
  $$('[data-close-repository-detail]').forEach((button) => button.addEventListener("click", closeRepositoryDetails));
  $$('[data-close-review-dialog]').forEach((button) => button.addEventListener("click", closeReviewDialog));
  $$('[data-close-changes-requested]').forEach((button) => button.addEventListener("click", closeChangesRequestedDialog));
  $("#create-task-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeTaskDialog(); });
  $("#add-repository-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeRepositoryDialog(); });
  $("#repository-detail-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeRepositoryDetails(); });
  $("#review-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeReviewDialog(); });
  $("#changes-requested-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeChangesRequestedDialog(); });
  $("#confirm-dialog-cancel").addEventListener("click", () => closeConfirmDialog(false));
  $("#confirm-dialog-submit").addEventListener("click", () => closeConfirmDialog(true));
  $("#confirm-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeConfirmDialog(false); });
  $("#task-drawer").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeTaskDetail(); });
  $("#top-user").addEventListener("click", () => {
    const menu = $("#account-menu");
    menu.hidden = !menu.hidden;
    $("#top-user").setAttribute("aria-expanded", String(!menu.hidden));
  });
  $("#logout-button").addEventListener("click", logout);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".account-control")) {
      $("#account-menu").hidden = true;
      $("#top-user").setAttribute("aria-expanded", "false");
    }
    $$('[data-agent-picker]').forEach((picker) => {
      if (!picker.contains(event.target)) closeAgentPicker(picker);
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const openAgentPicker = $("[data-agent-picker-menu]:not([hidden])")?.closest("[data-agent-picker]");
    if (taskWorktreeBrowserIsOpen()) closeTaskWorktreeBrowser();
    else if (openAgentPicker) closeAgentPicker(openAgentPicker);
    else if (platformAgentWorkspaceIsOpen() && matchMedia("(max-width: 760px)").matches) closePlatformAgentWorkspace();
    else if (!$("#confirm-dialog").hidden) closeConfirmDialog(false);
    else if (!$("#repository-detail-dialog").hidden) closeRepositoryDetails();
    else if (!$("#add-repository-dialog").hidden) closeRepositoryDialog();
    else if (!$("#changes-requested-dialog").hidden) closeChangesRequestedDialog();
    else if (!$("#review-dialog").hidden) closeReviewDialog();
    else if (!$("#create-task-dialog").hidden) closeTaskDialog();
    else if (!$("#task-drawer").hidden) closeTaskDetail();
  });
  wireDynamicButtons();
  initPlatformAgentWorkspace({
    onError: (message) => toast(message, "error"),
    onStartReview: startReviewAgent,
  });
  initTaskWorktreeBrowser({ api, onError: (message) => toast(message, "error") });
}

bindEvents();
setView(location.hash.slice(1) || "tasks", { updateHash: false });
if (await initializeAuthentication()) await loadData();
setInterval(() => {
  if (runnerOnboarding.enabled()) void runnerOnboarding.refresh();
  void refreshRepositoryProtocolsAutomatically();
  if (state.currentUser && state.tasks.some((task) => isRepositoryLifecycleTask(task) && task.pr_state !== "merged")) {
    loadData({ silent: true });
  }
}, 4000);
