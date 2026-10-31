# HTTP MCP 网关：WSL2 非 root systemd 部署与联调

本文是 P0 的本地部署示例，面向后续在 WSL2 上联调的部署人员。示例不含真实凭据；本轮**没有在 WSL2 上实际部署或验证**，真实 OA、真实业务站点和反向代理也未验证。

## 边界

- 一个项目目录运行一个网关实例。两个实例共享 `.e2e/http-jobs/` 会竞争同一批作业记录。
- 网关默认只监听 loopback。需要跨主机访问时，在前面放 TLS 反向代理，不要让网关直接暴露到网络。
- 项目中的测试脚本是受信任代码，以服务用户的完整权限执行。`save_test_script` 权限等同于允许该用户在当前项目里执行代码。
- `tools` 与 `principal` 只做功能授权和作业归属，**不是租户边界**。项目代码以服务用户运行，能读同一用户的 `/proc/<pid>/environ` 和项目目录；任何能保存或运行测试的客户端因此等价于该服务用户，也能拿到网关环境里的所有 token。互不信任的客户端不要接到同一实例：按客户端拆分 OS 用户、项目目录和实例，或用容器隔离。
- 同一 target 的 Job 并入同一个 Run，共享 Runner 与登录快照（`.e2e/` 下的 `sessions/` 等）。`principal` 区隔的是 Job 记录，不是浏览器会话或认证状态。需要隔离登录态时同样按客户端拆实例。
- 认证快照、截图和报告都落在项目输出目录（默认 `.e2e/`），随 Run 结束或保留期清理。

## 前置

- Node.js 满足包声明的下限（`engines.node`，当前为 22.22.3 及以上）。
- pnpm 11 或 12，用于安装项目依赖与构建。
- 服务用户与项目目录（示例使用 `e2e` 与 `/srv/e2e-project`）：

  ```bash
  sudo useradd --system --create-home --home-dir /srv/e2e-project --shell /usr/sbin/nologin e2e
  sudo install -d -m 0750 -o e2e -g e2e /srv/e2e-project
  sudo -u e2e -H bash -lc 'cd /srv/e2e-project && pnpm add -D e2e @e2e-dev/web'
  ```

  单元里的 `ExecStart` 指向项目内的 `node_modules/e2e/dist/cli/bin.js`，与 `npx e2e` 是同一套布局。把包装在 `/opt/e2e` 时，按实际路径修改 `ExecStart`。

- WSL2 发行版启用 systemd：在 `/etc/wsl.conf` 写入

  ```ini
  [boot]
  systemd=true
  ```

  然后在 Windows 执行 `wsl --shutdown` 并重新进入发行版。

## 凭据

生成至少 32 字符的随机 token，一个客户端一条：

```bash
openssl rand -hex 32
```

写入 `/etc/e2e/http-mcp.env`，权限 `600`，属主为 root。systemd 在切换到 `User=e2e` 之前读取该文件，服务进程和项目代码都不需要读它：

```bash
sudo install -d -m 0750 -o root -g root /etc/e2e
sudo install -m 0600 -o root -g root /dev/null /etc/e2e/http-mcp.env
```

文件归属只挡住对文件的读取。token 仍会进入网关进程的环境，同一服务用户的进程可以通过 `/proc/<pid>/environ` 读到（`ProtectProc=invisible` 只隐藏其他用户的进程）。要真正保护 token，必须让项目代码以不同用户或不同实例运行，见“边界”。

文件内容（把占位 token 换成实际值，不要把真实值提交到仓库）：

```ini
E2E_HTTP_MCP_TOKENS='[{"token":"<32+ characters>","principal":"alice","tools":["open_session","tools","call","close_session","list_test_scripts","get_test_script","save_test_script","run_test","get_test_status","get_test_report"]}]'
```

- `principal` 决定作业归属；授权作业工具时必填。
- 不写 `tools` 时只授予四个原生工具和两个脚本读取工具；保存脚本与作业工具必须显式列出。
- 一个 principal 可以有多条 token，但会话绑定到打开它的那条 token。
- 日志、报告和子进程环境都不会包含 token；不要把 token 放进项目目录或命令历史。

## 启动

```bash
cd /srv/e2e-project
set -a
. /etc/e2e/http-mcp.env
set +a
npx e2e mcp --http --host 127.0.0.1 --port 3001 \
  --max-workers 4 --max-runs 2
```

生产环境不要设置 `E2E_HTTP_MCP_*` 环境变量：它们是测试用来缩短 Run、Job、认证超时和保留期的未文档化开关，误设会让作业提前超时或被提前清理。

常用选项：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--host` | `127.0.0.1` | 监听地址；保持 loopback。 |
| `--port` | `3001` | `0` 表示随机端口，启动日志会打印实际地址。 |
| `--path` | `/mcp/e2e` | MCP 端点；不能是 `/healthz`，启动时拒绝。 |
| `--allow-host` | 绑定端口的 loopback 名 | 反向代理时设为外部域名（含端口）。 |
| `--allow-origin` | 绑定端口的 loopback 源 | 浏览器客户端跨域时设为实际源；不设通配。 |
| `--trusted-proxy` | 空 | 只信任列出的代理地址的 `X-Forwarded-For`，仅影响日志。 |
| `--max-sessions-per-domain` | `20` | 同一 principal 在同一目标域名（target 的 `app.url` host，无 URL 时用 target 名）可同时持有的会话数，1 到 100；超出时回收该组最久未活动的会话。HTTP 模式没有全局会话上限。 |
| `--session-ttl` | `600` | 空闲会话回收秒数；`0` 关闭。 |
| `--max-body` | `4194304` | 请求体上限，超出返回 413。 |
| `--max-workers` | `4` | 每个 Run 的 Worker 上限，1 到 64；只降不升。 |
| `--max-runs` | `2` | 同时存活的 Run 数，1 到 16；超限返回 `CAPACITY_EXCEEDED`。 |
| `--test-root` | 当前目录 | 脚本工具可读写的根目录。 |

Run 时限 30 分钟、Job 时限 15 分钟、认证时限 2 分钟、保留期 14 天固定由服务端控制，没有用户选项。

## systemd 单元（非 root）

Playwright 的 Chromium 需要预装到单元指定的目录。`ProtectHome=read-only` 让默认的 `~/.cache/ms-playwright` 不可写，运行时装浏览器会失败，所以由 root 装一次：

```bash
sudo install -d -m 0755 -o root -g root /opt/ms-playwright
sudo -u e2e -H env PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
  bash -lc 'cd /srv/e2e-project && pnpm exec playwright-core install chromium'
```

`playwright-core` 的 bin 只有在项目直接依赖它时才在根 `.bin` 里；没有时先 `pnpm add -D playwright-core`，或直接运行 `node_modules/.pnpm/playwright-core@*/node_modules/playwright-core/cli.js install chromium`。升级 `@e2e-dev/web` 后重跑一次。

把示例单元复制到 `/etc/systemd/system/http-mcp.service`，按实际路径修改 `ExecStart`、`WorkingDirectory` 和 `EnvironmentFile`：

```bash
sudo install -m 0644 docs/engineering/deploy/http-mcp.service /etc/systemd/system/http-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now http-mcp
```

单元要点：

- `User=e2e`，不使用 root；`UMask=0077` 让 Run 输出与作业记录默认不对其他用户可读。
- `EnvironmentFile` 指向 `/etc/e2e/http-mcp.env`，属主 root、权限 `600`。
- `ProtectSystem=strict` 与 `ReadWritePaths` 只放开项目目录；浏览器从只读的 `/opt/ms-playwright` 运行，`ProtectHome=read-only` 挡住用户目录写入。
- `ProtectProc=invisible` 与 `ProcSubset=pid` 对其他用户隐藏进程；同一用户的进程仍可见，token 隔离见“凭据”。
- `MemoryMax`、`CPUQuota`、`TasksMax` 限制资源；浏览器和 Worker 会按 `--max-workers` 与 `--max-runs` 叠加。
- `KillMode=mixed` 让 SIGTERM 只发给网关主进程，网关再按顺序封口 Run、等待子进程；默认的 `control-group` 会把 SIGTERM 同时发给所有 Runner 与浏览器，跳过优雅排空。
- `KillSignal=SIGTERM` 与 `TimeoutStopSec=150` 给网关留出停止余量：每个存活的 Run 最多 20 秒 stop grace，`--max-runs 2` 时叠加，再加每个 Runner 最多 5 秒硬杀。调大 `--max-runs` 时同步调大该值。
- `Restart=on-failure` 在异常退出后重启；重启会把未终结作业标为 `interrupted`，不重放，并清理上次崩溃遗留的 `runs/` 目录。

## 健康检查

```bash
curl -fsS "http://127.0.0.1:3001/healthz"
```

返回 `{"status":"ok","version":"...","sessions":<n>,"uptimeMs":...}`。`/healthz` 不需要 token、不读请求体，实际只会返回 200（正常）、403（Host/Origin 不在白名单）或 503（正在关闭）；它没有限流，版本号也会外露，对外暴露时在反向代理单独限制或拒绝该路径。`/mcp/e2e` 另有 401（token 缺失或错误）、403（Host/Origin 或跨主体会话）、404（未知路径或会话）和 413（请求体超过 `--max-body`）。HTTP 模式没有全局会话上限，不返回 429；超过 `--max-sessions-per-domain` 时回收同组最久未活动的会话。

## 日志与停止

```bash
journalctl -u http-mcp -f
sudo systemctl stop http-mcp
```

停止时网关先停止接收，再封口每个 Run，等待子进程退出；超过宽限的 Runner 被终止。被切断的作业标为 `interrupted`，不会在重启后重放。

## 反向代理

需要外部访问时：

1. 网关保持 `--host 127.0.0.1`。
2. 代理终结 TLS，并转发 `Authorization`、`Mcp-Session-Id`、`Mcp-Protocol-Version` 等头。
3. 设置 `--allow-host` 为外部域名（含端口）与 `--allow-origin` 为实际浏览器源。显式设置会整体替换默认的 loopback 列表，所以同时保留本机回环，否则 `curl http://127.0.0.1:3001/healthz` 会 403：

   ```bash
   --allow-host gw.example.com:443,127.0.0.1:3001,localhost:3001 \
   --allow-origin https://gw.example.com,http://127.0.0.1:3001,http://localhost:3001
   ```
4. 代理地址加入 `--trusted-proxy`，日志才会记录客户端地址。
5. 代理不要缓存 `/mcp/e2e` 的流式响应。
6. 浏览器客户端需要 CORS 预检；网关只校验 `Origin`，不返回 `Access-Control-*` 头，由反向代理补 `Access-Control-Allow-Origin`（回显配置的源，不要 `*`）和方法/头白名单。
7. 网关内置的限流只有按域名的 `--max-sessions-per-domain` 和 `--max-body`；请求速率与连接数在反向代理上限制（例如 nginx `limit_req`、`limit_conn`）。
8. `Host` 与 `Origin` 白名单防的是 DNS rebinding 和跨站请求伪造，不是网络访问控制；网络层仍要只放行反向代理。

## WSL2 网络

- WSL2 内的服务默认只在 WSL 虚拟网络可见。Windows 上的客户端用 `http://127.0.0.1:3001` 通常可以访问；跨主机访问需要端口转发或隧道，建议只通过 SSH 隧道使用，不要把 3001 直接暴露到局域网。
- 在 WSL2 内做真实站点联调时，确认项目 target 的 `app.url` 能从 WSL 访问，且登录凭据通过环境变量注入。

## 联调步骤

1. 启动服务并确认 `/healthz` 返回 200。
2. 在 MCP 客户端中配置 Streamable HTTP：URL `http://127.0.0.1:3001/mcp/e2e`，请求头 `Authorization: Bearer <token>`。Claude Code 的 `.mcp.json` 示例：

   ```json
   {
     "mcpServers": {
       "e2e": {
         "type": "http",
         "url": "http://127.0.0.1:3001/mcp/e2e",
         "headers": { "Authorization": "Bearer ${E2E_HTTP_MCP_TOKEN}" }
       }
     }
   }
   ```

   用环境变量占位符，不要把真实 token 写进 `.mcp.json`；该文件通常会被提交，或至少会留在项目目录里被测试代码读到。

3. 枚举工具与资源，确认得到原生工具、脚本工具和 `e2e://guide` 资源。
4. `open_session` 打开探索会话，用 `call` 执行 `navigate`、`observe`、`tap`；确认另一个会话看不到这些页面状态。
5. 用 `list_test_scripts` / `get_test_script` 检查脚本；需要修改时用 `save_test_script`（显式授权）。
6. `run_test` 提交 `targetId` 与脚本路径，记录返回的 `jobId`、`runId`。
7. 用 `get_test_status` 轮询到终态，再用 `get_test_report` 读取结果和失败证据。
8. 断开 MCP 连接后重新连接，用同一 token 查询原 `jobId`，确认作业继续并可读。
9. Run 封口（空 Run 的封口延迟是 2 秒）且其 Runner 子进程退出后，确认 `.e2e/http-jobs/runs/` 为空；作业记录保留 14 天。

## 未验证项

- 本示例未在 WSL2 上实际运行；systemd 单元、资源限制和浏览器依赖需要按目标环境调整。
- `ProtectProc=invisible` 与 `ProcSubset=pid` 需要 systemd 247 及以上和相应内核支持；WSL2 发行版要先确认。
- 浏览器预装命令取决于 pnpm 的依赖布局，未在目标环境执行过。
- 真实 OA 登录、Token 并发上下文、真实业务数据和实际反向代理未验证。
- 多客户端在同一实例上的 `principal` 隔离只覆盖作业记录；登录快照共享与 `/proc` 读取 token 的风险未通过实际渗透验证，投产前应按“边界”拆实例。
- 真实账号的凭据注入方式取决于部署环境；本文只给出环境变量位置。
