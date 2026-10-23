# HTTP MCP 会话配额调研记录

- 任务：`mcp-session-quota`
- 节点：`gitnexus-inquiry`
- 版本：`1`
- 工作区：`D:\workplace\typescript\e2e`
- 分支：`dev/e2e@0.21.2`
- 记录时间：2026-10-23T02:46Z（约）

## 需求输入

用户原始要求：

1. HTTP 的请求不设置上限。
2. 只有自动化相同用户和域名的 session 才设置默认上限 20。

需求中的“用户”“域名”“自动化”三个术语尚无代码侧定义，列入文末未确认项。

## GitNexus 检索记录

- 工具与范围：`mcp__remote_gitnexus__list_repos(limit=50)`、`mcp__remote_gitnexus__query`（省略 `repo`，跨所有已索引仓库聚合；节点 `scope=current_workspace`）。
- `list_repos` 结果：`total=36`、`hasMore=false`。列表中没有当前工作区 `D:\workplace\typescript\e2e` 或与之对应的索引仓库。
- 主查询完整 `search_query`：

```text
在所有已索引仓库中，围绕“HTTP MCP 网关会话数量上限（maxSessions / too_many_sessions / 429）与按用户 principal、按域名分组的会话配额”定位入口（HTTP 服务器路由、会话注册、token 鉴权、子进程会话）、实际处理实现、关键字段与状态转换、上下游调用链以及决定该行为的条件分支；输出精确仓库、文件路径、symbol、调用链与代码证据。若当前工作区仓库未被索引，明确说明缺少的证据。
```

- 查询返回：706,723 字符。排名靠前的流程来自 `MyDjangoProject`、`StateAllowanceDeclaration`、`dev-oa-order` 等业务仓库（如 `_handle_quota_not_enough_data`、`HandleSessionTokenMapping`），没有任何 e2e 框架仓库的流程、symbol 或文件。
- 失败分类：`repository_unindexed`。服务本身可用（查询正常返回聚合结果），当前工作区仓库未被 GitNexus 索引。
- 未能获得的能力：本仓库的调用图、`impact`、`trace`、完整消费者与索引新鲜度。
- 未使用 `list_repos` 的仓库名猜测目标项目，未查询其他业务仓库来代替本仓库证据。

## 参考依据

已按节点 `reference_topics` 读取：

- `research/gitnexus/gitnexus-code-inquiry.md`
- `research/gitnexus/gitnexus-local-fallback.md`
- `shared/handoff-fields.md`

`shared` 与 `research` 主题按 “mcp session limit quota principal domain” 检索均无命中。

## 本地降级检索记录

- `source: local_search`
- `authority: non_gitnexus`
- 检索根：`D:\workplace\typescript\e2e`
- 工具与模式：`rg` 只读文本检索与定向文件读取；未执行代码、构建、安装或网络请求。
- 覆盖范围：`packages/e2e/src/mcp/**`、`packages/e2e/src/cli/**`、`packages/e2e/tests/**`、`docs/reference/**`、`deploy/http-mcp/**`、`skills/e2e/**`、`plugins/e2e/**`。
- 排除：`.git`、`node_modules`、构建产物、缓存、日志、凭据与密钥。
- 限制：只能证明直接文本、定义与配置事实；不能证明调用边、完整影响范围或跨项目契约。

## 代码事实

### HTTP 网关的会话上限

- `packages/e2e/src/mcp/http/server.ts:38-40`：网关用 `sessions: Map<string, HttpSession>` 与 `closingSessions: Set<Promise<void>>` 记账；关闭中的会话继续占槽位。
- `packages/e2e/src/mcp/http/server.ts:213-219`：`sessions.size + closingSessions.size >= options.maxSessions` 时返回 `429 { error: 'too_many_sessions' }`。
- `packages/e2e/src/mcp/http/server.ts:107-114`：空闲计时器只在 `inFlight === 0` 时启动，`--session-ttl` 到期后 `closeById(..., 'idle timeout')`。
- `packages/e2e/src/mcp/http/config.ts:74`：`HttpMcpOptions.maxSessions`；`config.ts:90`：`sessionIdleMs`。
- `packages/e2e/src/cli/mcp.ts:194`：HTTP 模式 `maxSessions: options.maxSessions ?? SESSION_BOUNDS.default`。
- `packages/e2e/src/mcp/session.ts:45`：`SESSION_BOUNDS = { min: 1, max: 16, default: 4 }`。
- `packages/e2e/src/cli/mcp.ts:202`：`sessionIdleMs: (options.sessionTtl ?? 600) * 1000`。
- `packages/e2e/src/cli/index.ts:547`：`--max-sessions <n>`；`:558`：`--session-ttl <seconds>`。

### 会话身份与子进程

- `packages/e2e/src/mcp/http/config.ts:72-77`：`HttpMcpToken` 只有 `principal`、`tools`、`digest` 三项；网关没有任何目标站点或域名信息。
- `packages/e2e/src/mcp/http/session.ts:55-90`：每个 HTTP 会话对应一个 `HttpSession`，首次原生工具调用时懒启动一个 `e2e mcp` 子进程。
- `packages/e2e/src/mcp/http/session.ts:230-237`：子进程参数固定包含 `--max-sessions 1`。
- `packages/e2e/src/mcp/sessions.ts:193-194`：原生层每个子进程只允许 1 个会话，超限报 `SESSION_OPEN`。
- `packages/e2e/src/mcp/session.ts:255`：`open_session` 在子进程内用 `selectTarget(...)` 选择 target；target 名称经 MCP 代理转发，网关只看到参数文本。
- `packages/e2e/src/mcp/session.ts:473` 起：`open_session` 工具定义（可选 target、config、headed）。

### 网关与项目配置

- `packages/e2e/src/mcp/http/jobs.ts:8`：明确注释“The gateway never loads the project config: the child owns collection…”。
- `packages/e2e/src/mcp/http/jobs.ts:210-234`：`run_test` 以 `targetId` 为键建立/复用 Run；`jobs.ts:710-711` 的 runKey 含 `cwd`、`configPath`、`targetId`、`ACCOUNT`。
- `packages/e2e/src/mcp/http/jobs.ts:802-815`：Runner 子进程通过 `--cwd`、`--target`、`--output` 启动，由子进程加载配置。
- 项目配置中的 target 形如 `targets: [{ name, engine, app: { url } }]`（`../e2e_tests/e2e.config.ts`），域名只能来自 target 的 `app.url`。

### 部署现状

- `deploy/http-mcp/Dockerfile:23`：CMD 未传 `--max-sessions`，线上网关实际使用默认上限 4。
- `deploy/http-mcp/compose.yaml`：无命令覆盖。

### 文档与契约

- `docs/reference/mcp.mdx:50`：`--max-sessions` 默认 `4`；`:83-91`：取值 1–16；`:415`：并发会话上限；`:617`：超限 `429`；`:625`：每个子进程限一个原生会话；`:639-641`：会话关闭途径与 `--session-ttl 0`；`:661`：状态码表。
- `docs/reference/cli.mdx:372`：`--max-sessions` 说明；`:380`：`--session-ttl`。
- `docs/reference/security.mdx:363`：默认四个并发会话、关闭中的会话占位。
- `docs/reference/errors.mdx:142`：`SESSION_OPEN` 错误码。
- `skills/e2e/references/mcp.md:53,71,105,201` 与 `plugins/e2e/skills/e2e/references/mcp.md` 同步描述上述限制。

### 测试

- `packages/e2e/tests/integration/mcp-http.test.ts:474-489`：`--max-sessions 1` 下第二个会话期望 429，释放后恢复。
- `packages/e2e/tests/integration/mcp-http-concurrency.test.ts`：多 job 共享 Run、扩容与队列/运行上限。
- `packages/e2e/tests/unit/mcp-http-config.test.ts`、`mcp-http-scripts.test.ts`：网关配置与脚本工具单测。

## 推断（非 GitNexus 事实）

- 取消全局上限会改变 `mcp-http.test.ts:474-489` 的语义；该测试需随新契约调整。
- 按“同用户 + 同域名”限额需要网关在会话创建时确定域名，而当前网关没有 target→域名映射，也不加载项目配置。
- 可行的域名来源候选：项目配置中 target 的 `app.url` origin（需网关加载配置或由子进程回报）、HTTP `Origin` 头（当前只用于安全校验）、target 名称（不是域名）。
- `run_test` 已有 `--max-runs`（默认 2）与每 Run 20 个未完成 job 的限额；本次“默认上限 20”的会话配额若作用于 HTTP MCP 会话，需明确它是否也覆盖 job 与脚本工具会话。

## 未确认项（进入 grilling）

1. “域名”的精确含义：target 的 `app.url` origin、HTTP 请求 `Origin`，还是其他维度。
2. “自动化”指 MCP 代理会话（浏览器/设备自动化）还是所有 HTTP MCP 会话；仅脚本/作业工具令牌是否计入。
3. 尚未调用 `open_session` 的会话、以及显式切换 target 的会话归属哪个域名桶。
4. 20 的默认值是否可配置（按 principal、按 token、按部署），是否沿用 `--max-sessions` 名称。
5. 超限响应是否仍为 429，错误码/文案如何定义；关闭中的会话是否继续占名额。
6. 取消全局上限后，进程/浏览器资源由谁兜底（每会话一个子进程，原生会话才启动浏览器）。
7. `--session-ttl` 与空闲回收是否保持不变。
8. 文档与部署 CMD 是否同步修改（`docs/reference/mcp.mdx`、`cli.mdx`、`security.mdx`、`errors.mdx`、`skills/e2e/references/mcp.md`、`deploy/http-mcp/Dockerfile`）。

## 恢复动作

当前工作区仓库未被 GitNexus 索引。如需调用图、影响范围或完整消费者证据，需先将 `D:\workplace\typescript\e2e` 纳入 GitNexus 索引后重跑主查询；在此之前，以上本地证据保持 `non_gitnexus` 权威级别。

## 已确认决策（grilling r1–r3）

- 域名 = target 的 `app.url` 的 host；没有 `app.url` 的 target 回退用 target 名称作为域名键。
- 配额键 = `(principal, domain)`，同组共享默认上限 20。
- 所有 HTTP MCP 会话都属于自动化；尚未打开 target 的会话不占任何域名桶。
- HTTP 模式彻底移除全局 `--max-sessions` 上限；stdio 模式保留原行为。
- 新增 `--max-sessions-per-domain <n>`，默认 20，取值范围 1–100。
- 域名由 `open_session` 结果的 `structuredContent { target, platform, appUrl? }` 提供；网关不加载项目配置。
- 占用：`open_session` 成功时；释放：`close_session`、切换 target、HTTP 会话结束（含空闲 TTL）。
- 配额满时回收同桶最久未活动（LRU）的会话（关闭其 HTTP 会话与子进程）后放行；无可用回收对象（如全部有在途请求）时返回 MCP 工具错误 `session_quota_exceeded`。
- `--max-sessions` 与 `--http` 同时使用拒绝启动（`INVALID_ARGUMENT`）。
- 关闭中的会话继续计数。
