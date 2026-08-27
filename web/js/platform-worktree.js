// Full-page, read-only Task worktree browser. Platform only authenticates and
// relays these requests; file contents and Git diffs are computed by the Task
// participant's local Runner and are never persisted in Platform.
const $ = (selector, root = document) => root.querySelector(selector);
const ALL_CHANGES = "__all_changes__";

let requestApi = null;
let reportError = null;
let task = null;
let tab = "files";
let treePayload = null;
let changesPayload = null;
let tree = null;
let selectedPath = null;
let selectedPayload = null;
let fileView = "reader";
let openDirectories = new Set();
let activeRequest = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function stateBox(message, kind = "") {
  const content = $("#worktree-browser-content");
  content.replaceChildren();
  const box = document.createElement("div");
  box.className = `worktree-browser-state${kind ? ` ${kind}` : ""}`;
  box.textContent = message;
  content.append(box);
}

function treeState(message) {
  const target = $("#worktree-browser-tree");
  target.replaceChildren();
  const box = document.createElement("div");
  box.className = "worktree-browser-state";
  box.textContent = message;
  target.append(box);
}

function banner(message = "", kind = "") {
  const element = $("#worktree-browser-banner");
  element.hidden = !message;
  element.className = `worktree-browser-banner${kind ? ` ${kind}` : ""}`;
  element.textContent = message;
}

function busy(value) {
  const button = $("#worktree-browser-refresh");
  button.disabled = value;
  button.classList.toggle("busy", value);
  button.textContent = value ? "刷新中…" : "刷新";
}

function revision(payload) {
  const value = payload?.revision;
  $("#worktree-browser-revision").textContent = value?.commit
    ? `${value.label} @ ${String(value.commit).slice(0, 10)}${value.approximate ? " · 近似基线" : ""}`
    : "";
}

async function inspect(operation, path) {
  if (!task) throw new Error("Task worktree 尚未打开");
  activeRequest?.abort();
  const controller = activeRequest = new AbortController();
  return requestApi(`/api/platform/tasks/${encodeURIComponent(task.key)}/worktree/inspect`, {
    method: "POST",
    body: JSON.stringify({ operation, ...(path ? { path } : {}) }),
    signal: controller.signal,
  });
}

function buildTree(paths) {
  const root = { name: "", path: "", directories: new Map(), files: [] };
  for (const filePath of paths) {
    const parts = filePath.split("/");
    const fileName = parts.pop();
    let node = root;
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!node.directories.has(part)) {
        node.directories.set(part, { name: part, path: current, directories: new Map(), files: [] });
      }
      node = node.directories.get(part);
    }
    node.files.push({ name: fileName, path: filePath });
  }
  return root;
}

function sortByName(left, right) {
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

function openParents(path) {
  const parts = String(path || "").split("/");
  parts.pop();
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    openDirectories.add(current);
  }
}

function renderTreeNode(node, list, depth) {
  const directories = [...node.directories.values()].sort(sortByName);
  const files = [...node.files].sort(sortByName);
  for (const directory of directories) {
    const row = document.createElement("button");
    const isOpen = openDirectories.has(directory.path);
    row.type = "button";
    row.className = "worktree-tree-row worktree-tree-dir";
    row.style.setProperty("--depth", depth);
    row.setAttribute("aria-expanded", String(isOpen));
    const caret = document.createElement("span");
    caret.className = `worktree-tree-caret${isOpen ? " open" : ""}`;
    caret.textContent = "›";
    const label = document.createElement("span");
    label.className = "worktree-tree-label";
    label.textContent = directory.name;
    row.append(caret, label);
    row.addEventListener("click", () => {
      if (isOpen) openDirectories.delete(directory.path);
      else openDirectories.add(directory.path);
      renderNavigation();
    });
    list.append(row);
    if (isOpen) renderTreeNode(directory, list, depth + 1);
  }
  for (const file of files) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `worktree-tree-row worktree-tree-file${selectedPath === file.path ? " selected" : ""}`;
    row.style.setProperty("--depth", depth);
    row.title = file.path;
    const label = document.createElement("span");
    label.className = "worktree-tree-label";
    label.textContent = file.name;
    row.append(label);
    row.addEventListener("click", () => void selectFile(file.path));
    list.append(row);
  }
}

function statusStyle(status) {
  if (status === "A" || status === "?") return "add";
  if (status === "D") return "delete";
  return "modify";
}

function renderChanges() {
  const target = $("#worktree-browser-tree");
  target.replaceChildren();
  if (!changesPayload) return treeState("正在读取变更…");
  const list = document.createElement("div");
  list.className = "worktree-tree-list";
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = `worktree-tree-row worktree-change-summary${selectedPath === ALL_CHANGES ? " selected" : ""}`;
  summary.title = `当前 worktree 相对 ${changesPayload.revision.label} 的全部变更`;
  const summaryStatus = document.createElement("span");
  summaryStatus.className = "worktree-change-status summary";
  summaryStatus.textContent = "Σ";
  const summaryLabel = document.createElement("span");
  summaryLabel.className = "worktree-tree-label";
  summaryLabel.textContent = "全部变更";
  const count = document.createElement("span");
  count.className = "worktree-change-count";
  count.textContent = String(changesPayload.files.length);
  summary.append(summaryStatus, summaryLabel, count);
  summary.addEventListener("click", () => void selectAllChanges());
  list.append(summary);
  for (const change of changesPayload.files) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `worktree-tree-row${selectedPath === change.path ? " selected" : ""}`;
    row.title = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
    const status = document.createElement("span");
    status.className = `worktree-change-status ${statusStyle(change.status)}`;
    status.textContent = change.status === "?" ? "A" : change.status;
    const label = document.createElement("span");
    label.className = "worktree-tree-label";
    label.textContent = change.path;
    row.append(status, label);
    row.addEventListener("click", () => void selectChange(change.path));
    list.append(row);
  }
  target.append(list);
}

function renderNavigation() {
  if (tab === "changes") return renderChanges();
  const target = $("#worktree-browser-tree");
  target.replaceChildren();
  if (!treePayload) return treeState("正在读取文件树…");
  if (!treePayload.files.length) return treeState("当前 worktree 没有可见文件");
  const list = document.createElement("div");
  list.className = "worktree-tree-list";
  renderTreeNode(tree, list, 0);
  target.append(list);
}

function setPath(path, allowReader = false) {
  const target = $("#worktree-browser-path");
  target.replaceChildren();
  if (!path) return;
  const label = document.createElement("span");
  label.className = "worktree-path-label";
  label.textContent = path;
  label.title = path;
  target.append(label);
  if (!allowReader) return;
  const toggle = document.createElement("span");
  toggle.className = "worktree-view-toggle";
  for (const [value, text] of [["reader", "阅读"], ["source", "源文件"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = fileView === value ? "active" : "";
    button.textContent = text;
    button.addEventListener("click", () => {
      fileView = value;
      renderFile(selectedPayload);
    });
    toggle.append(button);
  }
  target.append(toggle);
}

function stripFrontmatter(content) {
  return String(content || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

function markdownHtml(content) {
  const output = [];
  const code = [];
  let inCode = false;
  for (const line of stripFrontmatter(content).split(/\r?\n/)) {
    if (line.startsWith("```")) {
      if (inCode) {
        output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code.length = 0;
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
    else if (/^\s*[-*]\s+/.test(line)) output.push(`<p class="list">• ${inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""))}</p>`);
    else if (line.startsWith("> ")) output.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`);
    else if (line.trim()) output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  if (code.length) output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  return output.join("") || "<p>文档正文为空。</p>";
}

function renderSource(content, path) {
  const target = $("#worktree-browser-content");
  target.replaceChildren();
  const layout = document.createElement("div");
  const wraps = /\.(?:md|mdx|ya?ml|json|toml|txt)$/i.test(path);
  layout.className = `worktree-source-layout${wraps ? " wrap" : ""}`;
  const lines = String(content).split("\n");
  const numbers = document.createElement("pre");
  numbers.className = "worktree-source-lines";
  numbers.textContent = lines.map((_, index) => index + 1).join("\n");
  const source = document.createElement("pre");
  source.className = "worktree-source-code";
  source.textContent = content;
  layout.append(numbers, source);
  target.append(layout);
}

function renderFile(payload) {
  selectedPayload = payload;
  if (!payload) return;
  const markdown = /\.mdx?$/i.test(payload.path);
  setPath(payload.path, markdown);
  if (payload.content == null) {
    const reason = { binary: "二进制文件无法预览", tooLarge: "文件过大，无法在浏览器中预览", symlink: "符号链接不在这里展开" }[payload.unavailable] || "文件无法预览";
    return stateBox(reason);
  }
  if (markdown && fileView === "reader") {
    const target = $("#worktree-browser-content");
    target.innerHTML = `<div class="worktree-markdown">${markdownHtml(payload.content)}</div>`;
    return;
  }
  renderSource(payload.content, payload.path);
}

function renderDiff(payload, label = payload.path) {
  selectedPayload = payload;
  setPath(label);
  if (payload.binary) return stateBox("二进制文件已发生变化，无法显示文本 Diff");
  if (payload.content == null) return stateBox(payload.truncated ? "Diff 过大，无法在浏览器中显示" : "没有可显示的文本 Diff");
  const target = $("#worktree-browser-content");
  target.replaceChildren();
  const diff = document.createElement("div");
  diff.className = "worktree-diff";
  const lines = payload.content.split("\n").slice(0, 10000);
  for (const line of lines) {
    const row = document.createElement("div");
    row.className = "worktree-diff-line";
    if (line.startsWith("+") && !line.startsWith("+++")) row.classList.add("add");
    else if (line.startsWith("-") && !line.startsWith("---")) row.classList.add("delete");
    else if (line.startsWith("@@")) row.classList.add("hunk");
    else if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) row.classList.add("meta");
    row.textContent = line || " ";
    diff.append(row);
  }
  target.append(diff);
  if (payload.truncated || payload.content.split("\n").length > 10000) banner("Diff 内容过长，当前只展示前一部分", "");
}

async function selectFile(path) {
  selectedPath = path;
  fileView = "reader";
  openParents(path);
  renderNavigation();
  $("#worktree-browser").classList.add("detail");
  setPath(path);
  stateBox("正在读取文件…");
  try {
    const payload = await inspect("file", path);
    revision(payload);
    renderFile(payload);
  } catch (error) {
    if (error?.name === "AbortError") return;
    stateBox(error.message, "error");
    banner(error.message, "error");
  }
}

async function selectChange(path) {
  selectedPath = path;
  renderNavigation();
  $("#worktree-browser").classList.add("detail");
  setPath(path);
  stateBox("正在生成 Diff…");
  try {
    const payload = await inspect("diff", path);
    revision(payload);
    renderDiff(payload);
  } catch (error) {
    if (error?.name === "AbortError") return;
    stateBox(error.message, "error");
    banner(error.message, "error");
  }
}

async function selectAllChanges() {
  selectedPath = ALL_CHANGES;
  renderNavigation();
  $("#worktree-browser").classList.add("detail");
  const label = `全部变更 · 相对 ${changesPayload?.revision?.label || "基准分支"}`;
  setPath(label);
  stateBox("正在生成整体 Diff…");
  try {
    const payload = await inspect("diff");
    revision(payload);
    renderDiff(payload, label);
  } catch (error) {
    if (error?.name === "AbortError") return;
    stateBox(error.message, "error");
    banner(error.message, "error");
  }
}

async function loadFiles(initialPath = null) {
  treePayload = null;
  tree = null;
  treeState("正在读取文件树…");
  stateBox("请从左侧选择文件");
  const payload = await inspect("tree");
  treePayload = payload;
  tree = buildTree(payload.files);
  revision(payload);
  if (payload.truncated) banner("文件数量较多，当前文件树只展示前一部分");
  renderNavigation();
  const fallback = payload.files.find((path) => path === ".alignyard/repository.yaml")
    || payload.files.find((path) => path.startsWith(".alignyard/") && /\.md$/i.test(path))
    || payload.files[0];
  const target = initialPath && payload.files.includes(initialPath) ? initialPath : fallback;
  if (target) await selectFile(target);
}

async function loadChanges(initialPath = null) {
  changesPayload = null;
  treeState("正在读取变更…");
  stateBox("正在生成整体 Diff…");
  const payload = await inspect("changes");
  changesPayload = payload;
  revision(payload);
  $("#worktree-tab-changes").textContent = `变更 · ${payload.files.length}`;
  renderNavigation();
  const target = initialPath && initialPath !== ALL_CHANGES && payload.files.some((file) => file.path === initialPath)
    ? initialPath
    : null;
  if (target) return selectChange(target);
  if (payload.files.length) return selectAllChanges();
  selectedPath = ALL_CHANGES;
  renderNavigation();
  setPath(`全部变更 · 相对 ${payload.revision.label}`);
  stateBox(`当前 worktree 相对 ${payload.revision.label} 没有变更`);
}

async function loadCurrent(initialPath = null) {
  busy(true);
  banner();
  selectedPath = null;
  selectedPayload = null;
  $("#worktree-browser").classList.remove("detail");
  setPath("");
  try {
    if (tab === "changes") await loadChanges(initialPath);
    else await loadFiles(initialPath);
  } catch (error) {
    if (error?.name === "AbortError") return;
    treeState("worktree 读取失败");
    stateBox(error.message, "error");
    banner(error.message, "error");
    reportError?.(error.message);
  } finally {
    busy(false);
  }
}

async function setTab(next, initialPath = null) {
  tab = next;
  for (const button of document.querySelectorAll("[data-worktree-tab]")) {
    button.classList.toggle("active", button.dataset.worktreeTab === tab);
  }
  await loadCurrent(initialPath);
}

export function openTaskWorktreeBrowser(nextTask, options = {}) {
  task = nextTask;
  openDirectories = new Set([".alignyard"]);
  treePayload = changesPayload = tree = selectedPayload = null;
  selectedPath = null;
  $("#worktree-browser-key").textContent = task.key;
  $("#worktree-browser-title").textContent = task.display_title || task.title || "Task worktree";
  const repository = task.repositories?.find((item) => item.mode === "editable") || task.repositories?.[0];
  $("#worktree-browser-repository").textContent = repository
    ? `${repository.name} · ${repository.work_branch || repository.base_branch || ""}`
    : "";
  tab = options.tab === "changes" ? "changes" : "files";
  for (const button of document.querySelectorAll("[data-worktree-tab]")) {
    button.classList.toggle("active", button.dataset.worktreeTab === tab);
  }
  $("#worktree-tab-changes").textContent = "变更";
  $("#worktree-browser").classList.remove("detail");
  revision(null);
  banner();
  treeState(tab === "changes" ? "正在读取变更…" : "正在读取文件树…");
  stateBox(tab === "changes" ? "正在生成整体 Diff…" : "正在读取文件…");
  $("#worktree-browser").hidden = false;
  document.body.classList.add("worktree-browser-open");
  void loadCurrent(options.path || null);
}

export function closeTaskWorktreeBrowser() {
  activeRequest?.abort();
  activeRequest = null;
  task = null;
  $("#worktree-browser").hidden = true;
  $("#worktree-browser").classList.remove("detail");
  document.body.classList.remove("worktree-browser-open");
}

export function taskWorktreeBrowserIsOpen() {
  return !$("#worktree-browser").hidden;
}

export function initTaskWorktreeBrowser({ api, onError }) {
  requestApi = api;
  reportError = onError;
  $("#worktree-browser-close").addEventListener("click", closeTaskWorktreeBrowser);
  $("#worktree-browser-refresh").addEventListener("click", () => void loadCurrent(selectedPath));
  document.querySelectorAll("[data-worktree-tab]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.worktreeTab !== tab) void setTab(button.dataset.worktreeTab);
  }));
  $("#worktree-browser-path").addEventListener("click", (event) => {
    if (matchMedia("(max-width: 760px)").matches && event.target === event.currentTarget) {
      $("#worktree-browser").classList.remove("detail");
    }
  });
}
