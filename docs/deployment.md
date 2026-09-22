# Platform 与 Runner 部署

当前方案面向一台普通 Linux VM，使用 Docker Compose 和 SQLite；没有绑定 GCP。GCP VM、AWS EC2、普通 VPS 或本机 Linux 都使用同一套部署方式。

## 业务约束与决策日志发布

本功能目标版本为 **Runner 0.1.13 / framework v5**，协议保持 v3。发布包含三个采用步骤，源码合入本身不会让业务仓库立即生效。

**发布 Alignyard**：合入包含本功能的分支，在发布 checkout 安装依赖并验证，再构建所需 Mac 架构的制品：

```sh
npm ci
npx tsc --noEmit --allowImportingTsExtensions
npm test
npm run -s ay -- validate .
npm run build:runner:macos
```

把新制品放到部署环境的 `dist/runner/stable/darwin-<arch>/`，部署新版 Platform（见下方“启动或升级”）。Review prompt 随 Platform 发布，CLI、默认模板和 Skill 随 Runner 发布；两边都需要更新。后续修改 Runner 源码时还应提升 `server/runner/VERSION`，不要覆盖同版本制品。

**安装本机工具**：通过 Web 安装引导重新运行新版 Runner 安装命令。已有 `~/.alignyard/runner.json` 时，安装器保留配对并重启服务。当前没有自动更新，Author 与 Reviewer 使用的 Runner 都应升级。检查：

```sh
alignyard-runner status
ay new --help
```

确认 `ay new --help` 出现 `--constraint` 与 `--author`；安装包 manifest 的版本应为 0.1.13 或包含本功能的后续版本。无需更改全局 Git 身份。

**更新业务仓库**：在独立工作分支执行，或使用 Alignyard 页面检测出的 Update Task：

```sh
ay update --check .
ay update .
ay validate .
ay update --check .
```

核对 diff：更新 README、模板、Skill 与 manifest，不改旧业务正文或已有署名。若从 protocol v1/v2 升到 v3，还需按现有规则迁移旧 Plan 的任务账本结构；署名本身始终可缺省。将变化提交、Review 并合入业务仓库，最后一次 check 应无待更新项，manifest 的 framework_version 为 5 或更新版本。

后续新任务读取新版 Skill 后，按“读取业务约束/ADR → 对照基线暴露冲突及联系人 → 人确认 → 更新约束并记录必要的新决策”工作。已有工作分支要合入框架更新并重新读取 Skill；正在运行的 Review 会话要重新加载新版提示，不能假定部署会改写已经发出的提示。

验证新建业务约束 Doc 和 ADR 可自动署名、手动修改或留空；不需要为验收在正式知识中留下测试文档。历史文档不批量回填。使用示例见 [业务关键约束与决策日志](../.alignyard/docs/server/business-constraints-and-decisions.md)。

## 1. 构建 macOS Runner 制品

分别在 Apple Silicon 和 Intel Mac 上运行：

```bash
npm ci
npm run build:runner:macos
```

输出位于 `dist/runner/stable/darwin-arm64/` 和 `dist/runner/stable/darwin-x64/`。每个压缩包包含官方 Node runtime、Alignyard Runner、`ay` 和 npm 依赖。当前 Apple Silicon 压缩包约 70 MB；用户已有 Node 时仍使用包内 runtime，以换取一致性。Codex、Claude、Kimi、gh、glab 不打包。

如果两种架构在不同机器构建，把两个目录都复制到部署仓库的 `dist/runner/stable/` 下。

## 2. 配置云端

```bash
cp .env.example .env
```

至少填写 `ALIGNYARD_AUTH_MODE`、`GOOGLE_CLIENT_ID` 和 `ALIGNYARD_ALLOWED_EMAILS`。Google OAuth 的 Authorized JavaScript origins 应包含最终 HTTPS 域名。不要把 `.env` 提交到 Git。

## 3. 启动或升级

```bash
./scripts/deploy-platform.sh
```

脚本执行 `docker compose up -d --build`，等待 `/healthz` 通过。容器只监听宿主机 `127.0.0.1:4500`，应由 Caddy、Nginx 或云负载均衡器终止 HTTPS，并转发 HTTP 与 WebSocket。

GCP 单 VM 部署可以使用仓库内的轻量发布脚本。它只上传当前 Git commit 和已构建的 Runner 制品，不在服务器保存 GitHub 凭据：

```bash
./scripts/deploy-gcp-vm.sh
```

默认目标是项目 `p02-internal-services`、区域 `asia-east1-b` 中的 `alignyard-platform-1`；可通过 `ALIGNYARD_GCP_PROJECT`、`ALIGNYARD_GCP_ZONE`、`ALIGNYARD_GCP_INSTANCE` 覆盖。VM 的 `/opt/alignyard/shared/.env` 独立于 release 保存，发布成功后 `/opt/alignyard/current` 指向当前版本。生产 Compose 覆盖文件会启动 Caddy，并根据 `ALIGNYARD_DOMAIN` 自动申请和续签 HTTPS 证书。

SQLite 数据保存在 Docker volume `alignyard-data`。不要运行多个 Platform 副本共享同一个 SQLite 文件；需要横向扩展时再迁移到 PostgreSQL。

## 4. 反向代理

Caddy 示例：

```caddyfile
alignyard.example.com {
  reverse_proxy 127.0.0.1:4500
}
```

`reverse_proxy` 会同时处理 `/runner` 和 `/pty` WebSocket。云防火墙只需要开放 80/443，不应直接开放 4500。

公网入口还应在反向代理或负载均衡器上限制 `/api/runner/claim` 与登录接口的请求速率。应用内暂未实现分布式 rate limit；不要依赖 pairing code 的随机性替代入口防护。

## 5. 用户安装 Runner

用户登录 Web 后，如果没有在线 Runner，页面会自动显示安装引导。它生成一个十分钟有效的一次性命令：

```bash
curl -fsSL 'https://alignyard.example.com/downloads/install-runner-macos.sh' \
  | bash -s -- --platform 'https://alignyard.example.com' --code 'XXXX-XXXX-XXXX'
```

安装位置：

- 应用：`~/.alignyard/app/<version>`；
- 配置：`~/.alignyard/runner.json`；
- 本地 runtime 数据：`~/.alignyard/runtime`；
- 日志：`~/.alignyard/logs`；
- LaunchAgent：`~/Library/LaunchAgents/com.alignyard.runner.plist`；
- 命令链接：`~/.local/bin/alignyard-runner` 与 `~/.local/bin/ay`。

首版制品未签名、未 notarize，也没有自动更新。正式对外发布前应增加 Apple Developer ID 签名、notarization、版本更新与回滚通道。

## 6. VM 运维

- 查看状态：`docker compose ps`；
- 查看日志：`docker compose logs -f alignyard`；
- 健康检查：`curl -fsS http://127.0.0.1:4500/healthz`；
- SQLite 备份必须使用 SQLite backup API，或停止容器后完整备份 `/data`；不要只复制打开状态下的主 `.db` 文件而忽略 WAL。

GCP 只负责 VM、持久磁盘、域名/HTTPS 和防火墙。可以另写一个本机小工具封装 `gcloud compute ssh/scp`，但它不应进入通用仓库的部署核心。
