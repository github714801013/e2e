# MCP 二进制产物下载调研记录

- 任务：`mcp-artifact-download`
- 节点：`gitnexus-inquiry`
- 版本：`1`
- 工作区：`D:\workplace\typescript\e2e`
- 分支：`dev/e2e@0.21.2`
- 记录时间：2026-10-28T11:20Z（约）

## 需求输入

用户原始问题：

> 修复这个bug: 它有截图、有文件，但没有办法把二进制文件传回来：
>
> data: URL 被运行策略禁止 —— 想用 base64 内联页面的路子一开始就被堵了。
> app.screenshot() 返回的是相对路径 screenshots/001.png，相对 /app 读不到。PROBE6 已经确认：cwd=/app、existsRel=false。它现在正顺着 /app/.e2e 递归找真实落盘位置（PROBE7）。
> e2e MCP 没有「下载产物」的工具。我核对了 remote_e2e__tools 的完整清单：只有 screenshot（把图发给模型看，不落你自己的盘）、start_recording/stop_recording（录屏路径在 /app/.e2e/videos/...，同样在远端容器里）。get_test_report 只回 JSON 统计，不回二进制。
> live session 无法登录 —— 它评估过用 start_recording 走实时会话录屏，但实时会话没有凭据注入，只有 test runner 能通过 credentials 认证。这条也堵了。
> 所以它现在是一个「东西做出来了，但没有出口」的局面 —— 跟你上午问 10099 没截图是同一类问题，只是这次 QA 主动在做，却被通道卡住。

拆解为四个阻塞点：

1. 运行策略禁止 `data:` URL，无法用 base64 内联页面的方式带出内容。
2. `app.screenshot()` 返回相对路径 `screenshots/001.png`；用户侧实测（PROBE6）`cwd=/app`、`existsRel=false`，即该路径相对远端容器的当前工作目录不可读。
3. MCP 工具面没有“下载产物”的工具；`screenshot` 只把图片发给模型，`start_recording`/`stop_recording` 只返回容器内路径，`get_test_report` 只返回 JSON。
4. 用户报告实时会话无法登录，认证只在 test runner 的凭证注入路径上可用。

调研前按节点要求检查 `docs/engineering/specs/`：不存在文件名前缀为 `mcp-artifact-download` 的 spec 文档，记录后继续。

## GitNexus 检索记录

- 工具与范围：`mcp__remote_gitnexus__query`（省略 `repo`，跨所有已索引仓库聚合；节点 `scope=current_workspace`），随后 `mcp__remote_gitnexus__list_repos(limit=200, isAll=true)` 复核索引状态。
- 主查询完整 `search_query`：

```text
在所有已索引仓库中，围绕“e2e MCP 能截图和录屏，但无法把二进制产物（screenshots/001.png、.e2e/videos/*.webm）传回调用方；screenshot 工具返回相对路径，get_test_report 只返回 JSON，没有下载工具；data: URL 被策略禁止；live session 无凭据注入”定位直接相关的入口（MCP tool 注册/HTTP server/资源、screenshot/start_recording/stop_recording/get_test_report 的实现、产物路径解析与输出目录、任何已有的 artifact/download/readFile 路由或工具、session 文件落盘位置）、实际处理实现、关键字段或状态转换、上游调用链以及决定该行为的条件分支和异常/反例；输出精确仓库、文件路径、symbol、入口到最终处理的调用链、每个关键条件的含义、调用方或消费者，以及支持“e2e MCP 需要新增或扩展哪个二进制产物下载入口，且现有 screenshot/recording 路径如何映射到该入口”的代码证据。不要只返回关键词命中；若仓库不匹配、索引不足、工具限制或无法建立调用链，明确说明缺少的证据。
```

- 查询返回的排名靠前流程全部来自 `MyDjangoProject`、`9ji-admin`、`jiuji-m`、`jiuji-mp`、`oa-pc`、`dev-huishou`、`dev-oanew` 等业务仓库，没有任何 e2e 框架仓库的流程、symbol 或文件。
- `list_repos` 结果：`pagination.total=55`、`hasMore=false`。55 个仓库中没有 `e2e`、`tester-army/e2e` 或与当前工作区路径对应的索引仓库。
- 失败分类：`repository_unindexed`。服务本身可用（聚合查询正常返回），当前工作区仓库未被 GitNexus 索引。
- 未能获得的能力：本仓库的调用图、`impact`、`trace`、完整消费者与索引新鲜度。
- 未使用 `list_repos` 的仓库名猜测目标项目，未查询其他业务仓库来代替本仓库证据。

## 参考依据

已按节点 `reference_topics` 读取：

- `research/gitnexus/gitnexus-code-inquiry.md`
- `research/gitnexus/gitnexus-local-fallback.md`
- `shared/general-specs.md`
- `shared/handoff-fields.md`

关键规则：未给精确项目名时首轮查询必须省略 `repo`；一次无命中不等于服务不可用；只有 `repository_unindexed`、服务/授权不可用、超时、索引陈旧、聚合不支持等才允许本地 fallback；本地证据必须标记 `source=local_search`、`authority=non_gitnexus`，且不能证明调用图、impact、跨项目 trace 与完整消费者。

## 本地降级检索记录

- `source: local_search`
- `authority: non_gitnexus`
- 检索根：`D:\workplace\typescript\e2e`
- 工具与模式：`rg` 只读文本检索与定向文件读取；未执行代码、构建、安装或网络请求。
- 覆盖范围：`packages/e2e/src/mcp/**`、`packages/e2e/src/run/**`、`packages/e2e/src/agent/primitives.ts`、`packages/e2e/src/internal/**`、`packages/web/src/**`、`packages/e2e/tests/**`、`docs/reference/**`、`deploy/http-mcp/**`、`skills/e2e/**`。
- 排除：`.git`、`node_modules`、构建产物、缓存、日志、凭据与密钥。
- 限制：只能证明直接文本、定义与配置事实；不能证明调用边、完整影响范围或跨项目契约。

## 代码事实

### 1. HTTP MCP 的工具面没有产物下载

- `packages/e2e/src/mcp/http/config.ts:12-28`：工具名固定为三组——原生 `open_session`、`tools`、`call`、`close_session`；脚本 `list_test_scripts`、`get_test_script`、`save_test_script`；异步 job `run_test`、`get_test_status`、`get_test_report`。没有 artifact/download 类工具，也没有对应的 token grant 名称。
- `packages/e2e/src/mcp/http/session.ts`：`tools/list` 只列允许的原生工具、脚本工具定义与 job 工具定义；`tools/call` 对脚本工具与 job 工具由网关本地处理，其余原生工具代理给 stdio 子进程。没有产物读取分支。
- `packages/e2e/src/mcp/server.ts:52-56`：MCP 指令只说明 `open_session`、`observe`、语法动作、`type_secret`、`locate`、`screenshot`、`start_recording`/`stop_recording` 与项目自有工具，没有下载产物的说明。
- `packages/e2e/src/mcp/catalog.ts:67-75`：会话目录只组合 `observe`、语法动作、`locate` 与录屏工具；只读集合为 `observe`、`locate`、`screenshot`。

### 2. HTTP 网关只服务两个路径

- `packages/e2e/src/mcp/http/server.ts:187-199`：网关只处理 `/healthz` 与配置的 `options.path`（默认 `/mcp/e2e`），其余路径 404。
- Host/Origin 校验在路径匹配之前执行；Bearer 鉴权在路径匹配之后执行。新增任何下载路由都必须重新组合这两层校验与 principal 归属检查。

### 3. live session 的 screenshot 与录屏

- `packages/e2e/src/agent/primitives.ts:580-585`：`screenshot` 工具执行 `screen.present(await context.observe({ pixels: true }))`，把图片作为 MCP image content 返回；不落盘，也不返回路径。
- `packages/e2e/src/mcp/tools.ts:26-36`：MCP content 类型只有 `text` 与 `image`（base64 data + mimeType），没有 `resource_link`、`blob`、`audio` 等类型。
- `packages/e2e/src/mcp/tools.ts:260-295`：`resultFromOutput` 把工具的 file part 转成 `image` content（base64），没有文件落盘或 URL 输出。
- `packages/e2e/src/mcp/recording.ts:136-147`：录屏结束时把分段文件从 attempt 目录 `rename` 到 `outDir`，返回绝对路径（或 provider URL）。
- `packages/e2e/src/mcp/recording.ts:186-193`：`stop_recording` 的描述明确说“返回每个视频文件的绝对路径，可直接附到 PR”；远端客户端拿到的是容器内路径。
- `packages/e2e/src/mcp/session.ts:371-390`：`SessionRecorder` 的 `outDir` 是 `outputLayout(config.output).videos(id)`，默认 `.e2e/videos/<session>/`，不在 artifact 目录内。

### 4. 测试产物：生成与注册

- `packages/web/src/surface.ts:1012-1034`：`artifactPath` 在 attempt artifact 目录下生成 `screenshots/NNN[-label].png` 的相对路径与绝对路径；`screenshot` 用该绝对路径写文件并返回相对路径。
- `packages/e2e/src/run/fixtures.ts:508-513`：`app.screenshot()` 调用引擎截图得到相对路径，然后 `environment.artifacts.register('screenshot', relative)` 注册该 artifact，并把相对路径返回给测试代码。
- `packages/e2e/src/run/artifacts.ts:93-130`：`register` 生成 `ArtifactRecord`，`reportPath = posix.join(...segments, relativePath)`，并计算 size 与 sha256；record 的 `path` 是 report-relative，不是容器绝对路径。
- `packages/e2e/src/run/records.ts:13-44`：`ArtifactRecord` 字段为 `id`、`kind`、`mediaType`、`path?`、`url?`、`size?`、`sha256?`、`ref?`、`redaction`、`producer`。
- `docs/reference/app.mdx:123-133`：文档明确 `app.screenshot()` 返回相对路径（相对 artifact root）。
- 因此测试中拿到的 `screenshots/001.png` 是 attempt artifact 目录内路径；用户的 `/app` 当前目录不是 artifact 目录。

### 5. job 运行：report 投影与输出删除

- `packages/e2e/src/mcp/http/job-tools.ts:59-71`：`get_test_report` 的描述为“per-test results、bounded failure evidence、artifact kinds；磁盘路径不包含”。
- `packages/e2e/src/mcp/http/jobs.ts:311-323`：report 只从 `record.results` 取 `IpcResult`，最多 50 条结果、256 KiB。
- `packages/e2e/src/run/dynamic-host.ts:221-238`：`projectResult` 只投影 `resultId`、标题、文件、状态、耗时、attempts、failure、skip；没有主动的 artifacts 字段。
- `packages/e2e/src/run/dynamic-host.ts:245-271`：attempt 视图里的 artifacts 只保留 `kind`、`mediaType`、`size`，最多 20 个，且只在失败证据路径出现。
- `packages/e2e/src/run/dynamic-ipc.ts:47-52`：`IpcArtifact` 注释明确“describes without a filesystem path”，字段只有 `kind`、`mediaType`、`size`。
- `packages/e2e/src/run/dynamic-ipc.ts:348-356`：`ipcArtifact` 只解析 `kind`、`mediaType`、`size`，不解析 `path`、`id`、`url`、`ref`。
- `packages/e2e/src/mcp/http/jobs.ts:441-445`：run 结束后删除 `run.output`（`.e2e/http-jobs/runs/<uuid>`）整个目录，注释说明“没有东西会再读一次已完成运行的输出”。
- `docs/reference/mcp.mdx:609-620`：job 记录写在 `.e2e/http-jobs/<jobId>.json`，每个 run 写在 `.e2e/http-jobs/runs/<random-id>/`，run 停止时删除；记录保留 14 天。
- 结论：job 的二进制产物在 run 结束后被删除；report 不携带路径、ID 或 URL；通过测试调用 `app.screenshot()` 产生的 artifact 不会出现在 report 里，失败测试也只能看到 kind。

### 6. 既有 ArtifactStore seam 被 IPC 截断

- `packages/e2e/src/run/artifacts.ts:118-195`：配置了 `artifacts.store` 时，`store.put` 接收 artifact 字节并返回 `ref`；`store.putLink` 可把 provider 托管的视频 URL 登记为 `ref`。`ref` 会写进本地 `ArtifactRecord`。
- `docs/reference/config.mdx:636-702`：项目可配置 `artifacts: { store }`，`store.put` 可上传到外部存储并返回 URL。
- 但 `dynamic-host.ts` 的 `projectResult` 与 `ipcArtifact` 不传 `ref`/`url`/`path`，`get_test_report` 也不返回这些字段。因此即使项目配置了外部存储，远端 MCP 调用方也拿不到可用链接。
- 当前部署项目是否配置了 `artifacts.store` 未确认。

### 7. 路径安全有可复用实现

- `packages/e2e/src/mcp/http/scripts.ts:305-340`：脚本路径解析依次检查空路径、控制字符、`.e2e.ts` 后缀、词法边界、`realpath` 后的父目录、符号链接，最终 realpath 仍须在 root 内。
- `packages/e2e/src/mcp/http/scripts.ts:580-587`：`inside` 与 `relativeTo` 提供词法边界判断与 POSIX 相对路径转换。
- `packages/e2e/src/internal/paths.ts:58-76`：`relativeToProjectRoot`、`insideProjectRoot` 提供 realpath 后的项目边界检查。
- 任何新增产物下载路径都必须做同等检查：词法路径、realpath、符号链接、root 边界、控制字符。

### 8. 部署挂载与保留

- `deploy/http-mcp/compose.yaml:14-17`：`./state:/app/.e2e` 持久化容器内 `.e2e`；`tests` 挂载到 `/app/tests`；`targets` 只读挂载到 `/run/e2e-targets`。
- `docs/engineering/deploy/http-mcp-docker.md:77-78`：`state/` 保存 Job 记录及运行数据。
- `.e2e` 卷可持久化新增的产物保留目录，但当前 `http-jobs/runs` 被删除，且 run 输出目录里还包含 auth snapshot 等不应对调用方开放的文件，不能简单保留整个 run 输出。
- `docs/reference/security.mdx:320-327`：artifact 目录、videos，以及 `videos/<session>` 不交给 `artifacts.store`。

### 9. `data:` URL 策略与导航策略是两件事

- `packages/e2e/src/internal/urls.ts:126-145`：`resolveNavigationUrl` 只允许 `http:`、`https:` 与精确的 `about:blank`；其他 scheme（含 `data:`）返回 `POLICY_DENIED`。这是浏览器/设备导航策略，不是产物传输策略。
- 用户所述的“运行策略禁止 data: URL”发生在调用方的运行环境，与仓库的导航策略相互独立；两者都指向同一个结论：不能靠内联 base64 页面把产物带出来。

### 10. 实时会话的凭据现状（与用户报告存在分歧）

- `packages/e2e/src/mcp/session.ts:433-444`：live session 打开时会展示配置的 `credentials` 与 `secrets`，测试可用 `type` 填用户名、用 `type_secret` 填密码。
- `packages/web/src/surface.ts:462-486`：`web({ basicAuth })` 把凭据配置为 Playwright 的 `httpCredentials`，由浏览器上下文应答 401。
- 因此“实时会话没有凭据注入”与仓库当前实现不完全一致；用户遇到的更可能是项目登录路径依赖了 live session 未共享的某种上下文（例如仅 job 子进程可见的环境变量、或项目自定义 fixture）。列为未确认项，须在 grill 阶段澄清。

## 差距结论

| 环节 | 现状 | 缺口 |
| --- | --- | --- |
| live session 截图 | 返回 image content（base64） | 不落盘、无下载句柄；远端只看到模型输入 |
| live session 录屏 | 保存到容器内 `.e2e/videos/<session>/`，返回绝对路径 | 调用方无法读取容器路径 |
| test `app.screenshot()` | 写 attempt artifact 目录，返回相对路径 | 相对路径相对 artifact 目录，不是 cwd；report 不含路径 |
| job 产物 | run 结束删除输出目录 | 无保留、无引用 |
| job report | 只回 JSON 统计与失败证据 | 无路径、无 ID、无 URL |
| MCP content | 只有 text/image | 无 resource link/blob |
| HTTP 网关 | 只有 `/healthz` 与 `/mcp/e2e` | 无认证的产物 GET 路由 |
| ArtifactStore | 可产生 `ref` | IPC 与 report 丢弃 `ref` |

一句话：产物在容器内被生成，但没有一条对 MCP 调用方可用的出口链路。

## 候选方向（待 grill-with-docs 决策，暂不选定）

- A. **job 产物保留 + 认证 HTTP 下载路由 + MCP 工具返回 URL**：run 结束后把声明的 artifact 复制到保留目录，新增受 Bearer/principal 保护的 GET 路由，`get_test_report` 或新工具返回可下载 URL。覆盖截图、视频、下载文件；需要保留策略、大小上限、路径安全、清理。
- B. **MCP 工具直接返回 base64 blob**：实现简单，但大视频与 JSON-RPC 开销不可接受，且很多客户端不会把 blob 落盘。只适合小截图。
- C. **只扩展 live session**：新增 `download_artifact` 工具读取会话产物目录；不解决 test job 的产物与保留问题。
- D. **复用 `ArtifactStore`**：让项目配置外部存储并在 report 返回 `ref`。开箱即用性差，需要项目侧配置与凭据，且不解决未配置 store 的部署。
- E. **report 返回相对路径 + 新下载工具**：仍需保留产物与路径解析；路径语义容易与容器 cwd 混淆。

## 未确认项

1. 部署项目是否配置了 `artifacts.store`，以及 MCP 网关子进程是否能看到该配置。
2. 用户环境的 `data:` URL 策略属于调用方还是 e2e；是否还有客户端侧的 URL 抓取能力。
3. 实时会话“无法登录”的具体失败点：是 basic auth、表单登录、还是 job 专属环境变量；需要在 grill 阶段用实际配置澄清。
4. 需要回传的产物范围：仅截图/视频，还是包括 download、log、trace。
5. 通过测试产生的 artifact 是否也要可取回，还是只处理失败证据。
6. 保留期限、单文件大小上限、总量上限与清理责任方。
7. 反向代理（`10.1.14.158:18091`）是否允许新增的 GET 路径与长连接；当前 Host allowlist 只列了精确主机名。
8. 调用方客户端是否支持 MCP `resource_link` 或直接 HTTP 下载 URL；这决定 URL 方案是否可行。
9. 产物下载的授权模型：同一 Bearer token、同一 principal、还是 job 级一次性令牌。

## 已确认设计决策（grill-with-docs，2026-10-28）

用户逐项确认“全部按推荐”，形成以下实现契约。

### 范围与传输

- 本次只做 **test job 产物**；live session 的 `screenshot` / `stop_recording` 不在本次范围，后续可复用同一下载链路。
- 传输方式：**认证 HTTP GET URL**。`list_test_artifacts` 返回产物描述与绝对下载 URL，调用方用现有 Bearer token 拉取。
- 产物类型：`screenshot`、`video`、`download`、`log`、`other` 全部暴露。
- 通过、失败、跳过、超时的结果都列出产物，不只失败证据。

### 接口

- 新增 MCP 工具 `list_test_artifacts({ jobId })`，返回 `{ jobId, ready, artifacts, truncated }`；`get_test_report` 保持不变。
- 每个产物描述包含 `artifactId`、`kind`、`mediaType`、`size`、`sha256`、`redaction`、`resultId`、`downloadUrl`（本地文件）或 `url`（provider 托管）；不返回文件系统路径。
- 下载路由：`<MCP path>/artifacts/<jobId>/<artifactIndex>`，GET；复用 Host/Origin 校验与 Bearer 鉴权，并校验 principal 与 job 归属；流式返回，带 `Content-Type`、`Content-Length`、`Content-Disposition`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`。
- URL 基址从已通过 allowlist 的请求 `Host` 推导；反向代理场景后续再加显式 public URL 配置。

### 保留与上限

- run 结束、删除 `run.output` 前，从 `<output>/report.json` 读出所有带本地 `path` 的 artifact，复制到 `.e2e/http-jobs/artifacts/<jobId>/`，并写 per-job 索引。
- 保留 **14 天**，与 job 记录一致；job 记录被 sweep 时同时删除产物目录。
- 单文件上限 **256 MiB**，单 job 上限 **1 GiB**；超限文件跳过并在清单中标注，不影响 job 结果。
- `url` 型 artifact 直接返回原 URL，不复制；只有 `ref` 而没有 `path` / `url` 的 artifact 在清单中标注为不可下载。
- 复制失败、`report.json` 缺失或损坏不改变 job 状态，只记录日志并在清单中标注。

### 非目标与后续

- 不改 `report.json` schema、不改 IPC 类型、不改 `ArtifactStore`、不改 runner 的产物注册。
- 不做 live session 录屏下载；后续可把 `stop_recording` 的路径接入同一路由。
- 不做浏览器/PR 附件所需的签名 URL；本次复用 Bearer。
- 登录并发问题不在框架层解决（见下）。

上述调研记录中的未确认项 1、2、4、5、6、8、9 已由本轮决策关闭；3（live session 登录失败的具体原因）与 7（反向代理新增 GET 路径）保留为后续事项。

## 部署登录调研（2026-10-28，root@10.1.14.158，只读）

- 部署目录：`/data2/project/e2e-http-mcp`；测试根 `/data2/project/e2e-http-mcp/tests/tests` 挂载到容器 `/app/tests`。
- 配置：部署项目 `workers: 4`；网关启动参数 `--max-runs 2`。
- 35 个 `.e2e.ts` 中，19 个使用 `credentials.user(...)` 并各自执行完整登录；22 个会打开 `/login`；只有 demo 的 `auth.e2e.ts` 使用 `test.setup` + `session.save`，`smoke.e2e.ts` 用 `{ session }` 恢复；0 个使用 `test.serial` / serial group。
- 8 个脚本硬编码 `TARGET = 'oa-test-1'`；10 个用 `externalTargetForBaseUrl(app.baseUrl)` 动态取 target。硬编码脚本对 `oa-saastest-2` 运行时会使用 dev 账号，存在错环境登录风险。
- 138 个 job 记录中，多文件 job 出现 OA 单会话拦截：
  - 2026-10-27 13:56，`price-protection-import` / `price-protection-fail-result` / `menu-probe`，两个失败，报错 `unhandled alert dialog: 你已在其他地方登陆!`。
  - 2026-10-28 05:51，`withhold-amount-readonly` / `salary-import-entry`，一个失败，报错 `你已经在其他地方登陆！`。
  - 2026-10-28 07:26，`tax-unit-column-save` / `tax-unit-export`，一个失败，报错 `你已经在其他地方登陆！`。
- 另有 2 组同 target 的 job 时间重叠（07:37、07:39），两次都是 `tax-unit-column-save` 失败、另一个 job 通过；失败原因是断言/定位超时，不能排除共享会话或共享业务数据的影响。
- 结论：每个脚本各自登录 + `workers: 4` + `--max-runs 2` 会触发同账号并发登录，OA 的新登录会踢掉旧会话。建议立即把部署项目 `workers` 改为 `1`、网关 `--max-runs` 改为 `1` 止血；长期改为每个 target 一个 `test.setup` 登录并 `session.save`，测试用 `{ session }` 复用登录态，写数据的测试仍串行。该问题与本次产物下载分开处理。

## 下一步

进入 `implement-no-tdd`，按上述接口、保留策略与上限实现，并补单元/集成测试、文档、skills 同步与 changeset。
