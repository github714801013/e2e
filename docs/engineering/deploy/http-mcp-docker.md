# HTTP MCP 的本机构建与 Linux Docker 部署

本例针对 `root@10.1.14.158`，服务目录 `/data2/project/e2e-http-mcp`，内网端点 `http://10.1.14.158:18091/mcp/e2e`。该目录和 Compose 项目只供本服务使用，不复用其他项目的端口或数据。

## 两个仓库的职责

- 当前框架仓库保存 `deploy/http-mcp/` 和 `scripts/http-mcp/`。构建读取当前工作区，包含未提交的 HTTP MCP 修改。
- `https://code.9ji.com/aiteam/e2e_tests.git` 保存测试项目。`e2e.config.ts`、`fixtures/`、`tests/` 和 `support/` 随镜像交付；`tests/` 在服务器可写挂载，MCP 保存的脚本会保留。`support/` 是镜像代码，修改后需要重新构建；`tests/` 可以通过 MCP 保存。
- 构建临时副本用本次打包的 `e2e`、`@e2e-dev/web` tarball 替换官方依赖。测试仓库版本号与官方版本相同，但官方包不含本次未发布改动。
- 框架工作区不提交、不推送。测试仓库只本地提交，不推送；服务器接收本地构建产物，不从远端拉取尚未推送的文件。

## 本机构建

需要 Node `^22.22.3 || >=24.8.0`、pnpm 12.3.4、可构建 `linux/amd64` 的 Docker、OpenSSH、tar。安装脚本不读取或打包宿主机 `.env`、SSH 密钥、Windows `node_modules`。Windows Git Bash 执行本文命令前设置 `export MSYS_NO_PATHCONV=1 PYTHONUTF8=1 LANG=C.UTF-8`，防止容器或服务器路径被转换成本机路径。

在框架仓库执行一键部署。`--pnpm` 指向实际 pnpm JavaScript 入口：

```bash
export MSYS_NO_PATHCONV=1 PYTHONUTF8=1 LANG=C.UTF-8
node scripts/http-mcp/deploy.mjs \
  --project "../e2e_tests" \
  --pnpm "<pnpm 安装目录>/bin/pnpm.mjs"
```

脚本会构建并打包框架和 web 引擎，生成 linux/amd64 镜像，传输到独立 release，校验 SHA-256，调用远端 `deploy.py` 启动容器，并打印服务地址。`--from <构建目录>` 可以直接重发已有产物；`--targets <文件>` 会同时上传测试地址和账号文件。构建目录包含 `image.tar`、`tests.tar.gz`、`compose.yaml`、`deploy.py`、`metadata.json` 与 LF 换行的 `SHA256SUMS`。元数据记录两个仓库的提交、是否有未提交修改、包摘要和镜像配置摘要。

## 多个测试地址和账号

测试地址和账号不写进构建脚本或镜像。服务器私有文件 `targets/targets.json` 在容器启动时读取，挂载到 `/run/e2e-targets/targets.json`，每个地址对应一个全权限测试账号：

```json
[
  {
    "name": "oa-test-1",
    "url": "https://oa-test-1.example.com",
    "username": "e2e_all",
    "password": "replace-with-the-test-account-password"
  }
]
```

`name` 会同时成为 target 名和 credential 名，测试可以用 `credentials.user(target.name)` 取账号。地址按 `app.baseUrl` 匹配，测试不需要写死 URL；`support/targets.ts` 已提供 `externalTargetForBaseUrl()`。多个地址可以同时存在，MCP 的 `open_session` 和 `run_test` 用 target 名选择。

本地维护 `e2e_tests/targets.local.json`（已加入 `.gitignore`），部署时上传：

```bash
node scripts/http-mcp/deploy.mjs \
  --project "../e2e_tests" --pnpm "<pnpm 安装目录>/bin/pnpm.mjs" \
  --targets "../e2e_tests/targets.local.json" \
  --from "<已有构建目录>"
```

只更新地址或账号时使用 `--from`，不需要重新构建镜像。脚本会以 UID/GID `1000:1000`、权限 `0600` 安装 `targets.json`；已有文件在不传 `--targets` 时保持不动。测试账号密码不进入 Git、不进入镜像、不出现在部署输出中。

如果 OA 是扫码或 SSO 登录，这个用户名密码配置不能直接完成登录，需要先确认测试服务账号或 API 登录方式。

## 传输与启动

一键脚本已经包含下面步骤。排障时可以手工执行，以下 `<构建目录>` 与 `<release>` 替换为真实值：

```bash
ssh "root@10.1.14.158" "umask 077; mkdir -p /data2/project/e2e-http-mcp/releases/<release>"
scp "<构建目录>/image.tar" "<构建目录>/tests.tar.gz" \
  "<构建目录>/compose.yaml" "<构建目录>/deploy.py" "<构建目录>/metadata.json" \
  "<构建目录>/SHA256SUMS" \
  "root@10.1.14.158:/data2/project/e2e-http-mcp/releases/<release>/"
ssh "root@10.1.14.158" \
  "cd /data2/project/e2e-http-mcp/releases/<release> && sha256sum -c SHA256SUMS && LANG=C.UTF-8 PYTHONUTF8=1 python3 -I deploy.py --root /data2/project/e2e-http-mcp --release /data2/project/e2e-http-mcp/releases/<release>"
```

部署程序导入镜像并核对镜像配置摘要，以兼容 Docker Desktop 与服务器 Docker 的镜像 ID 表示。首次创建随机 token，保存到服务器 `.secrets.env`，权限 `0600`，不输出到日志。测试、数据和地址目录归属容器 UID/GID `1000:1000`；`targets.json` 由部署脚本安装为 `0600`，服务根目录仅 root 可读。更新前核对同名 Compose 项目确实属于该目录；新镜像启动失败时恢复旧镜像和脚本，保留数据。若 Docker 失联，无法确认新容器已停止，则保留现场与旧脚本备份，报告服务状态未知。

## 持久化与更新保护

| 服务器路径 | 用途 |
| --- | --- |
| `tests/` | 测试脚本，挂载到 `/app/tests`，允许 MCP 保存。 |
| `state/` | 挂载到 `/app/.e2e`，保存 Job 记录及运行数据。 |
| `targets/targets.json` | 多个测试地址和账号，只读挂载到 `/run/e2e-targets/`。 |
| `.secrets.env` | 稳定的团队 token，更新不重置。 |
| `.deploy.env` | 当前镜像标签。 |
| `.tests-baseline.json` | 上次部署的脚本摘要。 |
| `releases/` | 构建元数据、归档和上一版脚本。 |

更新先比较服务器脚本与上次部署摘要，新增、修改、删除都会阻止覆盖。初检通过后停止网关并复检，避免 MCP 保存与部署相互覆盖。没有基线的已有目录不会自动接管。

发现脚本变化时，先取回并审阅，将需要保留的脚本纳入测试仓库，再安排新的部署。不要删除摘要文件来绕过保护，不使用目录级删除同步。

## 验收

验证脚本只通过 SSH 将 token 读入内存，不作为命令参数传递，不输出秘密。`<验收文件>` 位于本机系统临时目录：

```bash
node scripts/http-mcp/verify.mjs \
  --url "http://10.1.14.158:18091/mcp/e2e" \
  --ssh "root@10.1.14.158" --root "/data2/project/e2e-http-mcp" \
  --output "<验收文件>"
```

它验证健康检查、401、Origin 拒绝、原生浏览器输入和点击、脚本保存/列举/覆盖拒绝、保持探索会话打开时的异步 Job、结果报告与幂等提交。生成的脚本在验收期间保留在服务器测试目录内，供检查持久化；检查完成后可归档到该 release 的 `acceptance-scripts/`，避免验证产物永久阻止后续部署。

记录本服务容器 ID，重建后确认 ID 已变化，再运行同一脚本的 `--recheck "<验收文件>"`，验证原脚本和已完成 Job 报告保持一致。

```bash
ssh "root@10.1.14.158" \
  "cd /data2/project/e2e-http-mcp && docker compose --env-file .deploy.env ps -q gateway"
ssh "root@10.1.14.158" \
  "cd /data2/project/e2e-http-mcp && docker compose --env-file .deploy.env up -d --force-recreate --pull never --wait && docker compose --env-file .deploy.env ps -q gateway"
node scripts/http-mcp/verify.mjs \
  --url "http://10.1.14.158:18091/mcp/e2e" \
  --ssh "root@10.1.14.158" --root "/data2/project/e2e-http-mcp" \
  --recheck "<验收文件>"
```

## 运维与访问

```bash
ssh "root@10.1.14.158" \
  "cd /data2/project/e2e-http-mcp && docker compose --env-file .deploy.env ps"
ssh "root@10.1.14.158" \
  "cd /data2/project/e2e-http-mcp && docker compose --env-file .deploy.env logs --tail 100 gateway"
curl -fsS "http://10.1.14.158:18091/healthz"
```

MCP 客户端使用 Streamable HTTP 与 `Authorization: Bearer <token>`。凭据通过服务器的受控渠道交付，不写入提交、截图或日志。客户端配置应引用环境变量。

当前按单可信团队部署。同一 target 的 Job 共享 Run 与认证快照，`principal` 不构成租户隔离。容器内测试代码具有容器用户的完整权限。外部访问应加 HTTPS，当前内网 HTTP 本身不加密 token。

默认每 Run 最多 4 个 Worker、最多 2 个 Run；原生探索会话另占浏览器资源。配置为 4 CPU、8 GiB 内存、1 GiB 共享内存、150 秒停止宽限。资源值需按真实站点测量后调整。

本轮只验收确定性示例，不包含真实 OA、业务账号或模型调用。
