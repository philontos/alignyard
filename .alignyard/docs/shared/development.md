---
id: doc.shared.development
title: "开发、测试与运维"
kind: doc
scope: shared
owners: []
relations:
  - doc.shared.architecture
  - doc.server.cli-configuration
  - doc.server.runner-protocol
  - doc.server.knowledge-protocol
  - doc.web.overview
  - spec.server.framework-update
  - adr.shared.platform-runner-separation
---

# 概述

仓库使用 Node.js 22+、TypeScript/ES modules、SQLite 和原生浏览器 ES modules。服务端由 `tsx` 执行，Web 无 bundler。Platform 与 Runner 共用依赖和执行内核，但分别从唯一组合根启动。

## 本地开发

```sh
npm ci
ALIGNYARD_AUTH_MODE=local ALIGNYARD_DATA_DIR=/tmp/alignyard-dev npm run dev
```

`npm run dev` watch `server/platform/main.ts`。使用独立 `ALIGNYARD_DATA_DIR` 可以避免测试数据与本机正式 Runner 冲突。源码方式启动 Runner：

```sh
ALIGNYARD_DATA_DIR=/tmp/alignyard-runner-dev npm run runner -- doctor
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | watch 模式启动 Platform |
| `npm start` | 启动 Platform |
| `npm run runner -- <命令>` | 源码方式运行 Runner CLI |
| `npm run -s ay -- <命令>` | 运行工程知识 CLI |
| `npm run build:runner:macos` | 构建当前 Mac 架构的自包含 Runner 制品 |
| `npm test` | 运行服务端与 Web 全量测试 |
| `npx tsc --noEmit --allowImportingTsExtensions` | TypeScript 静态检查 |
| `npm run -s ay -- validate .` | 校验 `.alignyard/` 工程知识 |
| `docker compose config` | 校验通用部署配置 |
| `./scripts/deploy-platform.sh` | 构建、启动并等待 Platform 健康 |

## Runner 制品

`scripts/build-runner-macos.sh` 为当前 `arm64` 或 `x64` 构建：

```text
dist/runner/stable/darwin-<arch>/
  alignyard-runner.tar.gz
  alignyard-runner.tar.gz.sha256
  manifest.json
```

制品包含 Node runtime、锁定的 npm 依赖、Runner/`ay` launcher 和所需源码。系统已安装 Node 时仍使用包内 runtime，以保证 Node/native module ABI 一致。Runner 使用独立的 `server/runner/VERSION`，不因 Platform-only 修改被迫升级。

构建脚本把 Node archive 缓存在用户 cache，并对 Runner 所需源码、lockfile、launcher 和构建脚本计算稳定指纹。版本、源码指纹和 archive SHA-256 都一致时直接复用已有制品；同一版本下源码指纹改变则构建失败，发布者必须先提升 Runner version。首次构建或 Node 版本变化需要联网下载，产物不提交 Git。

## Platform 部署

仓库提供通用 Docker/Compose 部署脚本，以及从开发机打包当前 Git revision、上传并在既有 GCP VM 切换 release 的辅助脚本：

1. 从 `.env.example` 创建部署环境文件，只在目标机保存秘密值。
2. 在相应架构上构建 Runner 制品，并把 `dist/runner` 挂载为只读下载目录。
3. 执行 `./scripts/deploy-platform.sh`。
4. 用 Caddy、Nginx 或云负载均衡终止 HTTPS，并转发普通 HTTP 与 WebSocket upgrade。
5. 备份 `/data`，保持单实例运行。

`scripts/deploy-gcp-vm.sh` 只接受 clean、已提交的 HEAD：本地复用或构建 Runner 制品，通过 `git archive` 生成 release bundle，上传既有 VM，在 VM 上构建容器、健康检查后切换 `current`。部署目标可由环境变量覆盖；密钥和 `.env` 只保留在目标机 shared 目录。脚本不创建云资源、不提交 Git，也不把运行凭据写入制品。

## 目录与拆分规则

- 组合根只做装配；业务状态机放 `platform/` 或 `runner/operations`。
- HTTP 路由只做认证、校验和错误映射；不要直接操作 Git/tmux。
- 本机执行能力依赖 `LocalExecutor`/`CommandRunner` 小接口，不依赖 Host/Fleet 抽象。
- 新交互按完整闭环拆到 `web/js/features/` 与 `web/css/features/`；不要继续扩大页面级入口。
- 对超过约 500 行且包含多类职责的文件优先按领域拆分；同一状态机仍应保留在一个高内聚模块中。
- 删除旧功能时同步删除源文件、测试、依赖、静态资源和文档，避免形成影子产品。

## 提交前检查

```sh
npx tsc --noEmit --allowImportingTsExtensions
npm test
npm run -s ay -- validate .
docker compose config
sh -n scripts/deploy-platform.sh
sh -n scripts/build-runner-macos.sh
sh -n web/downloads/install-runner-macos.sh
git diff --check
```

再执行敏感信息扫描，至少覆盖 `.alignyard/`、README、部署文件和示例。不得提交真实邮箱、OAuth client ID、云项目/主机、Repository/Task 内容、token、pairing code 或本机绝对路径。
