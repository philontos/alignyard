const state = {
  view: "tasks",
  tasks: [],
  repositories: [],
  artifacts: [],
  taskFilter: "all",
  selectedTask: null,
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
  draft: "待启动",
  active: "进行中",
  pushed: "已推送",
  in_review: "等待 Review",
  approved: "已批准",
  merged: "已合并",
  closed: "已关闭",
};

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

function isDone(task) {
  return task.status === "merged" || task.status === "closed";
}

function filteredTasks() {
  const query = $("#task-search")?.value.trim().toLowerCase() || "";
  const priorities = { in_review: 0, active: 1, pushed: 2, draft: 3, approved: 4, merged: 5, closed: 6 };
  return state.tasks.filter((task) => {
    if (state.taskFilter === "mine" && task.owner !== "Phil") return false;
    if (state.taskFilter === "review" && task.status !== "in_review") return false;
    if (state.taskFilter === "done" && !isDone(task)) return false;
    if (!query) return true;
    const haystack = [task.key, task.title, task.description, task.owner, ...task.repositories.map((repo) => repo.name)].join(" ").toLowerCase();
    return haystack.includes(query);
  }).sort((left, right) => (priorities[left.status] ?? 9) - (priorities[right.status] ?? 9));
}

function renderTaskList() {
  const target = $("#task-list");
  const tasks = filteredTasks();
  target.classList.remove("loading-block");
  if (!tasks.length) {
    const completelyEmpty = state.tasks.length === 0;
    target.innerHTML = `<div class="empty-state"><div><span class="empty-symbol">${completelyEmpty ? "＋" : "⌕"}</span><h3>${completelyEmpty ? "从第一个共享 Task 开始" : "没有匹配的 Task"}</h3><p>${completelyEmpty ? "登记需求、相关 Repository 和负责人；随后团队成员即可在各自本机接手执行。" : "调整筛选条件或搜索内容后再试。"}</p>${completelyEmpty ? '<button class="button primary" type="button" data-create-task>创建第一个 Task</button>' : ""}</div></div>`;
    wireDynamicButtons(target);
    return;
  }
  target.innerHTML = tasks.map((task) => `<button class="task-row" type="button" data-task-key="${escapeHtml(task.key)}">
    <span class="task-main"><span class="task-key-line"><span class="task-key">${escapeHtml(task.key)}</span>${statusPill(task.status)}</span><strong class="task-title">${escapeHtml(task.title)}</strong><small class="task-description">${escapeHtml(task.description || "尚未填写需求说明")}</small></span>
    <span class="repo-chips">${repositoryChips(task.repositories)}</span>
    <span class="task-owner"><span class="mini-avatar">${escapeHtml(initial(task.owner))}</span>${escapeHtml(task.owner)}</span>
    <span class="task-time">更新于<br>${escapeHtml(formatDate(task.updated_at, true))}</span>
  </button>`).join("");
  $$('[data-task-key]', target).forEach((button) => button.addEventListener("click", () => openTaskDetail(button.dataset.taskKey)));
}

function renderTaskSummary() {
  const active = state.tasks.filter((task) => ["draft", "active", "pushed"].includes(task.status)).length;
  const review = state.tasks.filter((task) => task.status === "in_review").length;
  const done = state.tasks.filter(isDone).length;
  $("#summary-active").textContent = active;
  $("#summary-review").textContent = review;
  $("#summary-done").textContent = done;
  $("#nav-task-count").textContent = state.tasks.length;
  $("#nav-review-count").textContent = review;
}

function renderTasks() {
  renderTaskSummary();
  renderTaskList();
}

function filteredRepositories() {
  const query = $("#repo-search")?.value.trim().toLowerCase() || "";
  return state.repositories.filter((repo) => !query || `${repo.name} ${repo.git_url}`.toLowerCase().includes(query));
}

function renderRepositories() {
  const target = $("#repository-grid");
  const repositories = filteredRepositories();
  $("#nav-repo-count").textContent = state.repositories.length;
  $("#repo-total-label").textContent = `${state.repositories.length} 个 Repository`;
  target.classList.remove("loading-block");
  if (!repositories.length) {
    target.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div><span class="empty-symbol">◇</span><h3>${state.repositories.length ? "没有匹配的 Repository" : "Repository Catalog 还是空的"}</h3><p>${state.repositories.length ? "换一个名称或 Git 地址试试。" : "登记一个团队成员都能发现的 Git 地址；每个人仍使用自己的权限拉取。"}</p>${state.repositories.length ? "" : '<button class="button primary" type="button" data-add-repository>登记第一个 Repository</button>'}</div></div>`;
    wireDynamicButtons(target);
    return;
  }
  target.innerHTML = repositories.map((repo) => {
    const taskCount = state.tasks.filter((task) => task.repositories.some((item) => item.id === repo.id)).length;
    return `<article class="repository-card">
      <div class="repo-card-head"><span class="repo-glyph">${escapeHtml(initial(repo.name))}</span><div><h3>${escapeHtml(repo.name)}</h3><small>由 ${escapeHtml(repo.created_by)} 登记</small></div></div>
      <p class="repo-url" title="${escapeHtml(repo.git_url)}">${escapeHtml(repo.git_url)}</p>
      <div class="repo-meta"><span class="meta-chip">⑂ ${escapeHtml(repo.default_branch)}</span><span class="meta-chip">${taskCount} Tasks</span></div>
      <div class="manifest-waiting"><span>●</span> Manifest 等待本地 ay sync</div>
      <div class="repo-actions"><button class="button primary small" type="button" data-open-local="${escapeHtml(repo.name)}">本地打开</button><button class="button secondary small" type="button" data-task-from-repo="${repo.id}">创建 Task</button></div>
    </article>`;
  }).join("");
  $$('[data-open-local]', target).forEach((button) => button.addEventListener("click", () => copyCommand(`ay repo open ${button.dataset.openLocal}`)));
  $$('[data-task-from-repo]', target).forEach((button) => button.addEventListener("click", () => openTaskDialog(Number(button.dataset.taskFromRepo))));
}

function renderReviews() {
  const target = $("#review-list");
  const reviewTasks = state.tasks.filter((task) => task.status === "in_review");
  $("#review-total-label").textContent = `${reviewTasks.length} 项`;
  target.classList.remove("loading-block");
  if (!reviewTasks.length) {
    target.innerHTML = `<div class="empty-state"><div><span class="empty-symbol">✓</span><h3>当前没有等待 Review 的 Task</h3><p>Task 推送分支并通过 <code>ay sync</code> 固定 commit 后，会进入这里。</p></div></div>`;
    return;
  }
  target.innerHTML = reviewTasks.map((task) => `<button class="review-row" type="button" data-task-key="${escapeHtml(task.key)}" style="width:100%;border-left:0;border-right:0;border-top:0;background:transparent;text-align:left">
    <span><span class="review-meta"><b class="task-key">${escapeHtml(task.key)}</b><span>·</span><span>${escapeHtml(task.owner)}</span><span>·</span><span>${task.repositories.length} Repositories</span></span><h3>${escapeHtml(task.title)}</h3><p>${task.artifacts.length ? `${task.artifacts.length} 份工程知识等待确认` : "等待本地同步 specs、ADR、docs 快照"}</p></span>
    ${statusPill(task.status)}
  </button>`).join("");
  $$('[data-task-key]', target).forEach((button) => button.addEventListener("click", () => openTaskDetail(button.dataset.taskKey)));
}

function artifactKind(kind) {
  const normalized = String(kind || "docs").toLowerCase();
  if (normalized === "adr") return "adr";
  if (normalized === "spec" || normalized === "specs") return "specs";
  return "docs";
}

function renderKnowledge() {
  const counts = { docs: 0, specs: 0, adr: 0 };
  state.artifacts.forEach((artifact) => { counts[artifactKind(artifact.kind)] += 1; });
  $("#knowledge-docs").textContent = counts.docs;
  $("#knowledge-specs").textContent = counts.specs;
  $("#knowledge-adr").textContent = counts.adr;
  $("#knowledge-pending").textContent = state.artifacts.filter((artifact) => artifact.review_status !== "approved").length;
  const target = $("#artifact-list");
  if (!state.artifacts.length) {
    target.innerHTML = `<div class="empty-state"><div><span class="empty-symbol">⌘</span><h3>等待第一次 manifest 同步</h3><p>在本机打开一个 Task 后执行 <code>ay sync</code>，这里将出现由 commit 固定的 docs、specs 和 ADR 变更。</p></div></div>`;
    return;
  }
  target.innerHTML = state.artifacts.map((artifact) => {
    const kind = artifactKind(artifact.kind);
    return `<article class="artifact-row"><span class="artifact-kind ${kind}">${escapeHtml(kind.slice(0, 4))}</span><div><strong>${escapeHtml(artifact.title || artifact.path)}</strong><small>${escapeHtml(artifact.repository_name)} · ${escapeHtml(artifact.path)}</small></div><span>${escapeHtml(artifact.task_key)}</span></article>`;
  }).join("");
}

function renderAll() {
  renderTasks();
  renderRepositories();
  renderReviews();
  renderKnowledge();
}

function setView(view, { updateHash = true } = {}) {
  const allowed = ["tasks", "repositories", "reviews", "knowledge"];
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
    const selected = repo.id === preselectId;
    return `<label class="repo-option ${selected ? "selected" : ""}">
      <input type="checkbox" value="${repo.id}" ${selected ? "checked" : ""} />
      <span><strong>${escapeHtml(repo.name)}</strong><small>${escapeHtml(repo.git_url)}</small></span>
      <select aria-label="${escapeHtml(repo.name)} 关联方式"><option value="editable">editable</option><option value="reference">reference</option></select>
      <input type="text" value="${escapeHtml(repo.default_branch)}" aria-label="${escapeHtml(repo.name)} 基准分支" />
    </label>`;
  }).join("");
  $$('.repo-option input[type="checkbox"]', target).forEach((checkbox) => checkbox.addEventListener("change", () => checkbox.closest(".repo-option").classList.toggle("selected", checkbox.checked)));
}

function openTaskDialog(preselectId) {
  const form = $("#create-task-form");
  form.reset();
  form.elements.owner.value = "Phil";
  $("#task-form-error").textContent = "";
  taskRepositoryOptions(preselectId);
  $("#create-task-dialog").hidden = false;
  setTimeout(() => form.elements.title.focus(), 0);
}

function closeTaskDialog() { $("#create-task-dialog").hidden = true; }
function openRepositoryDialog() {
  const form = $("#add-repository-form");
  form.reset();
  form.elements.default_branch.value = "main";
  form.elements.created_by.value = "Phil";
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
  const payload = Object.fromEntries(new FormData(form).entries());
  const submit = $("#add-repository-submit");
  submit.disabled = true;
  submit.textContent = "登记中…";
  $("#repo-form-error").textContent = "";
  try {
    const repository = await api("/api/platform/repositories", { method: "POST", body: JSON.stringify(payload) });
    state.repositories.unshift(repository);
    closeRepositoryDialog();
    renderAll();
    if (!$("#create-task-dialog").hidden) taskRepositoryOptions(repository.id);
    toast(`${repository.name} 已进入 Repository Catalog`);
  } catch (error) {
    $("#repo-form-error").textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = "登记 Repository";
  }
}

function detailRepository(repo) {
  return `<article class="detail-repo"><div><strong>${escapeHtml(repo.name)}</strong><small>${escapeHtml(repo.git_url)}</small></div><span class="mode-badge ${repo.mode === "reference" ? "reference" : ""}">${escapeHtml(repo.mode)}</span><div><strong>${escapeHtml(repo.base_branch)}</strong><small>${escapeHtml(repo.work_branch || "固定为只读上下文")}</small></div></article>`;
}

function taskNextAction(task) {
  if (["draft", "active", "pushed"].includes(task.status)) return `<button class="button secondary" type="button" data-set-status="in_review">标记为待 Review</button>`;
  if (task.status === "in_review") return `<button class="button primary" type="button" data-set-status="approved">批准 Task</button>`;
  if (task.status === "approved") return `<button class="button primary" type="button" data-set-status="merged">标记为已合并</button>`;
  return "";
}

function openTaskDetail(key) {
  const task = state.tasks.find((item) => item.key === key);
  if (!task) return;
  state.selectedTask = task;
  const artifacts = task.artifacts?.length ? task.artifacts.map((artifact) => `<article class="artifact-row"><span class="artifact-kind ${artifactKind(artifact.kind)}">${escapeHtml(artifactKind(artifact.kind).slice(0, 4))}</span><div><strong>${escapeHtml(artifact.title || artifact.path)}</strong><small>${escapeHtml(artifact.path)}</small></div><span>${escapeHtml(artifact.review_status)}</span></article>`).join("") : `<div class="detail-empty">尚未收到 manifest 结果。成员在本地执行 <code>ay sync</code> 后，这里会显示 docs、specs 和 ADR 的差异。</div>`;
  $("#task-detail").innerHTML = `<div class="detail-top"><span class="task-key">${escapeHtml(task.key)}</span><h1>${escapeHtml(task.title)}</h1><p>${escapeHtml(task.description || "尚未填写需求说明")}</p></div>
    <div class="detail-meta">${statusPill(task.status)}<span>负责人：${escapeHtml(task.owner)}</span><span>创建于 ${escapeHtml(formatDate(task.created_at))}</span></div>
    <div class="detail-command"><span>ay task open ${escapeHtml(task.key)}</span><button type="button" data-copy-task-command>复制命令</button></div>
    <section class="detail-section"><div class="detail-section-head"><h2>Repositories · ${task.repositories.length}</h2><span class="protocol-badge">peer worktrees</span></div><div class="detail-repos">${task.repositories.map(detailRepository).join("")}</div></section>
    <section class="detail-section"><div class="detail-section-head"><h2>工程知识 · ${task.artifacts?.length || 0}</h2><span class="protocol-badge">manifest snapshot</span></div><div class="artifact-list">${artifacts}</div></section>
    <div class="detail-actions"><button class="button primary" type="button" data-copy-task-command>在本地打开</button>${taskNextAction(task)}</div>`;
  $("#task-drawer").hidden = false;
  $$('[data-copy-task-command]', $("#task-detail")).forEach((button) => button.addEventListener("click", () => copyCommand(`ay task open ${task.key}`)));
  $$('[data-set-status]', $("#task-detail")).forEach((button) => button.addEventListener("click", () => setTaskStatus(task.key, button.dataset.setStatus)));
}

function closeTaskDetail() { $("#task-drawer").hidden = true; state.selectedTask = null; }

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

async function loadData() {
  if (state.loading) return;
  state.loading = true;
  try {
    const [repositories, tasks, artifacts] = await Promise.all([
      api("/api/platform/repositories"),
      api("/api/platform/tasks"),
      api("/api/platform/artifacts"),
    ]);
    state.repositories = repositories;
    state.tasks = tasks;
    state.artifacts = artifacts;
    renderAll();
  } catch (error) {
    toast(`无法加载预览数据：${error.message}`, "error");
    $$(".loading-block").forEach((target) => { target.innerHTML = `<div class="empty-state"><div><h3>数据加载失败</h3><p>${escapeHtml(error.message)}</p></div></div>`; });
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
  $("#task-search").addEventListener("input", renderTaskList);
  $("#repo-search").addEventListener("input", renderRepositories);
  $("#create-task-form").addEventListener("submit", submitTask);
  $("#add-repository-form").addEventListener("submit", submitRepository);
  $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", closeTaskDialog));
  $$('[data-close-repo-dialog]').forEach((button) => button.addEventListener("click", closeRepositoryDialog));
  $("#create-task-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeTaskDialog(); });
  $("#add-repository-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeRepositoryDialog(); });
  $("#task-drawer").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeTaskDetail(); });
  $("#drawer-close").addEventListener("click", closeTaskDetail);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("#add-repository-dialog").hidden) closeRepositoryDialog();
    else if (!$("#create-task-dialog").hidden) closeTaskDialog();
    else if (!$("#task-drawer").hidden) closeTaskDetail();
  });
  wireDynamicButtons();
}

bindEvents();
setView(location.hash.slice(1) || "tasks", { updateHash: false });
loadData();
