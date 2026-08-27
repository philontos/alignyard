# Alignyard 工程意图

这个目录是 Repository 中随代码版本管理的核心工程意图与架构约束真源。它只记录未来 AI 不知道时可能造成整体设计漂移的信息；具体函数、局部算法和普通字段传递仍以代码、类型和测试为准。

`repository.yaml` 声明固定入口与逻辑 scopes；Docs 记录当前有效的稳定架构事实，Specs 描述一次变化的意图与边界，ADRs 保存长期取舍，Plans 提供可选的可执行技术方案。文档作者和审核轨迹优先使用 Git commit 与 PR/MR/Alignyard Review，不额外维护一套作者字段。

使用 `ay new` 创建文档，在 Review 前运行 `ay validate` 并提交全部改动。工程文档始终保存在 Git Repository 和 worktree 中；Alignyard Platform 不保存正文、摘要或副本。
