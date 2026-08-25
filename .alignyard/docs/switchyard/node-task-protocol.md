---
id: doc.switchyard.node-task-protocol
title: "节点归属与任务协议"
kind: doc
scope: switchyard
owners: []
relations:
  - doc.switchyard.overview
  - doc.switchyard.cli-configuration
  - doc.switchyard.http-realtime-api
  - doc.alignyard.task-workflow
---

# 概述

Switchyard 的核心不变量是“状态下沉到 owner 节点”。本地节点与远端节点使用相同数据布局；控制器只在查看时聚合远端结果，绝不在自己的数据库中复制并接管远端 Repository、任务、worktree 或 tmux 真相。

## 节点归属与传输

每个实例有稳定 `node_id`/namespace，本机在 `hosts` 表中始终有一条 `kind='local'` 记录。普通 Repository 和任务查询通过 `server/core/ownership.ts` 与 `server/http/context.ts` 限制为本机 owner；历史控制器时代的远端行只供 `tdsp doctor legacy` 审计。

节点通过 Tailscale 身份、`/.well-known/switchyard` 描述符和双向 handshake 建立关系，交换稳定节点身份、准确 `tdsp` 路径和 profile 专用 Ed25519 public key。发现/握手可以先完成，实际命令和终端必须等 SSH ready。远端操作使用参数转义后的 `ssh <node> <tdsp-path> ...`；未安装 Switchyard 或缺少准确启动器路径时拒绝兼容执行。

`tdsp list` 在目标节点现场计算 tmux、worktree 和权限等待状态。控制端并行查询节点，单个节点失败只产生 `unreachable`、`version` 或 `error`，不会污染其他节点，也不会用缓存假装在线。

## Repository 与 Git 布局

Repository 注册后在 `<data-dir>/mirrors/<repo-id>-<safe-name>.git` 创建 bare mirror。分支抓取使用 blobless fetch，并写入 `refs/remotes/origin/*`；本地 `refs/heads/*` 留给并发任务 worktree，避免更新远端分支时与已 checkout 的工作分支冲突。

普通 Repository 任务的工作目录为 `<data-dir>/worktrees/<repo-id>-<task-id>`，默认工作分支为 `feat/<task-id>-<slug>`。Alignyard 可以显式提供稳定分支 `change/<task-key>/<member>`。创建任务时先固定 `base_commit`，再启动 tmux/Agent；启动失败会反向清理已建引用和主 worktree，把任务记为 `error` 并留下 manifest 供诊断。

`repos.json` 是本节点 Repository catalog 的版本化形状副本，只含 id、name、git URL、default branch、相对 mirror 路径和时间，不含 token。

## 任务与工作区 manifest

每个任务在 `<data-dir>/tasks/<id>/` 下写两份文件：

- `task.json`：`schema_version: 2`，包含任务行和可选引用；版本只能做向后兼容的增量升级。
- `workspace.json`：`schema_version: 1`，描述一个 `editable` 主工作区和若干 `reference` 工作区，供 Agent 理解路径、分支和固定 commit。

所有 rename、resume、stop、cleanup 等任务变更都应重新从 sqlite 投影 manifest。启动时，节点可以从磁盘收养数据库缺失的 manifest，但只能收养本地任务，且 Repository 必须已经属于本节点；已存在数据库行不会被 manifest 覆盖。

## 引用仓库协议

引用仓库按请求的 ref 解析到确切 commit，以 detached worktree 放在 `<data-dir>/worktrees/refs/<task-id>/<alias>`。alias 会规范化和去重，refspec 必须安全，主 Repository 不能同时作为引用，远端 owner 的 Repository 不能被本节点引用。

引用路径随 Agent 的 `--add-dir` 传入，并在启动提示和 `workspace.json` 中标为 `reference`。这是只读协作语义；除非用户明确改变任务范围，Agent 不应修改引用 worktree。恢复任务前必须确认主 worktree 与所有引用仍存在，缺少任意一个就返回 `worktreeGone`。

## Agent 会话

session 名遵循 `tdsp-<namespace>-<id>-...`，兼容旧 `task-...`。任务记录 `agent` 和可选 `agent_model`；恢复按原值重建：Claude 使用 cwd 会话与可选 `ANTHROPIC_*` Provider，Codex/Kimi 使用对应 CLI 和模型参数。受信任的自动化任务可以跳过交互式审批/仓库信任门槛，普通任务保持交互行为。

tmux 持有会话，浏览器只是 attach 客户端。关闭浏览器不会结束任务；多个浏览器可以独立 attach。Claude 的权限等待信号来自 worktree 内约定文件，其他 Agent 不应伪造该状态。

## 生命周期与删除保护

1. 创建阶段先写 `creating`，成功后为 `running`；失败为 `error`。
2. `stop`/HTTP archive 杀死 tmux 并标记 `cleaned`，但保留主和引用 worktree，以便 `resume`。
3. `resume` 要求 session 名、主 worktree 和全部引用存在；成功后恢复为 `running`。
4. `cleanup` 杀死 session，先删除引用 worktree，再删除主 worktree和引用记录，保留一条 `cleaned` 历史任务记录。
5. `delete-task` 仅删除 durable record 和 manifest；任何主或引用 worktree 仍存在时必须拒绝。

远端控制操作必须在目标节点执行同一套生命周期函数。控制器不得直接改远端状态，也不得在“节点离线”时把操作回退到本地。
