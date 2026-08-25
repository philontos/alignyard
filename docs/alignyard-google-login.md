# Alignyard Google 登录

Alignyard 支持两种认证模式：本地开发默认使用 `local`，部署环境使用 `google`。用户与平台 session 保存在本机 SQLite；Google ID token 只用于登录时校验，不会保存 access token、refresh token 或 Client Secret。

## 本地开发

不设置认证环境变量即可启动：

```sh
PORT=14580 npm run dev
```

默认身份是 `Phil`。需要调整本地显示身份时可以设置：

```sh
ALIGNYARD_LOCAL_USER="Phil" ALIGNYARD_LOCAL_EMAIL="wyuhao.cn@gmail.com" PORT=14580 npm run dev
```

## 本地验证 Google 登录

按照 [Google Identity Services 设置说明](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid) 在 Google Cloud Console 创建 Web application OAuth Client，并把以下地址加入 Authorized JavaScript origins：

```text
http://localhost:14580
http://127.0.0.1:14580
```

随后设置：

```sh
export ALIGNYARD_AUTH_MODE=google
export GOOGLE_CLIENT_ID="<web-client-id>"
export ALIGNYARD_ALLOWED_EMAILS="wyuhao.cn@gmail.com,another-user@gmail.com"
export ALIGNYARD_API_TOKEN="<至少 32 字节的随机值>"
PORT=14580 npm run dev
```

`ALIGNYARD_ALLOWED_EMAILS` 是允许登录的 Google 账号列表。新增成员后，对方登录一次就会出现在 Reviewer 列表中。只有明确设置 `ALIGNYARD_AUTH_ALLOW_ANY_GOOGLE=1` 才允许任意已验证 Google 邮箱登录；带 Agent shell 的部署不建议这样配置。

`ALIGNYARD_API_TOKEN` 只供平台启动的 Agent 和 `ay sync` 等非浏览器调用使用。服务端会把它注入自己创建的 Agent session；手动运行 `ay sync` 时可通过 `AY_PLATFORM_TOKEN` 传入同一个值。

## Google VM 部署

生产环境应使用域名和 HTTPS，并把最终来源（例如 `https://alignyard.example.com`）加入 Authorized JavaScript origins。建议让反向代理终止 TLS，再转发到只监听回环地址的 Alignyard：

```sh
HOSTS=127.0.0.1 PORT=14580 npm start
```

不要把应用端口直接暴露到公网。将上述四个认证环境变量放进权限受限的服务配置或 secret 管理中，不要提交进仓库。SQLite 数据目录需要持久化备份；多用户共享同一台 VM 时，所有用户与 session 都由这一份数据库管理。

浏览器提交的是 ID token，服务端按 [Google 官方服务端校验方式](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token) 使用 Google Auth Library 校验签名、issuer 和 audience，再用稳定的 `sub` 建立平台身份。平台 session 使用 `HttpOnly`、`SameSite=Lax` Cookie，生产 HTTPS 下自动设置 `Secure`。所有 `/api` 路由和 `/pty` Agent WebSocket 都要求平台 session 或服务令牌。
