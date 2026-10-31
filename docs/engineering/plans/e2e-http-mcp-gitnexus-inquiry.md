# E2E HTTP MCP 二次开发调研记录

- 任务：`e2e-http-mcp`
- 节点：`gitnexus-inquiry`
- 交接前版本：`1`
- 工作区：`D:\workplace\typescript\e2e`
- 分支：`dev/e2e@0.21.2`
- 当前进度：用户已更正目录，子 Agent 已读取需求文档全文 1009 行并提取需求；尚未取得源码证据。

## 需求输入核验

用户指定的完整路径为：

```text
D:/download/E2E_HTTP_MCP_BDE8A690E5A880E68BAFE5B38FE58C95E5808FE6B9A1%88.md
```

子 Agent 的 Read 返回 `File does not exist.`。主 Agent 随后使用 Glob，限定在 `D:/download` 以 `E2E_HTTP_MCP*.md` 查找候选文件，返回 `Directory does not exist: D:/download.`，没有搜索其他目录。

主 Agent 再使用 Python `pathlib` 独立核实该精确路径，结果为 `document_exists=false`、`parent_exists=false`。未推断替代文件名，未读取其他下载文件。需求目标、接口、鉴权、会话、部署和验收条件均未取得，不能据文件名补写需求。

子 Agent 按节点要求使用一次 Glob 检查 `docs/engineering/specs/e2e-http-mcp*`，返回 specs 目录不存在。未读取其他任务规格。

## GitNexus 查询

主 Agent 实际调用 `mcp__remote_gitnexus__query`，范围限定当前工作区，`repo` 为 `D:\workplace\typescript\e2e`。完整 `search_query` 如下：

```text
在仓库 D:\workplace\typescript\e2e 中，围绕“根据 E2E HTTP MCP 文档进行二次开发”定位直接相关的入口（e2e mcp CLI、MCP Server、传输层与会话生命周期）、实际处理实现、关键字段或状态转换、上游下游调用链以及决定该行为的条件分支和异常或反例；核对现有 stdio 或 HTTP 传输、鉴权、参数校验、响应组装、异常映射和直接消费者；输出精确仓库、文件路径、symbol、入口到最终处理的调用链、每个关键条件的含义、调用方或消费者，以及支持“当前 MCP 能力与增加 HTTP MCP 所需修改边界”的代码证据。不要只返回关键词命中；若仓库不匹配、索引不足、工具限制或无法建立调用链，明确说明缺少的证据。
```

工具返回：

```text
Error: Repository is not available through this MCP server.
```

随后调用 `list_repos(limit=50)`，返回 `total=36`、`hasMore=false`。列表中没有与当前工作区、用户 fork 或官方仓库匹配的项目。该结果仅说明本次未取得目标仓库的 GitNexus 访问或索引，不能据此认定代码中不存在相关能力。没有查询其他仓库，也没有取得目标仓库的索引新鲜度。

上述查询先于文档读取及主 Agent 的路径存在性复核；工具调用的精确时间未另行记录。

## 参考依据与取证范围

已通过当前节点挂载的 research 主题读取：

- `gitnexus/gitnexus-code-inquiry.md`
- `gitnexus/gitnexus-local-fallback.md`

共享主题 `shared/.` 检索 `HTTP MCP` 无命中。首次省略 topic/path 的 reference-read 返回参数错误；用户明确授权后，分别指定 `research/gitnexus` 与 `shared/.`，第一次修正重试成功。

本节点 `required_files=[]`。未用 Read、Grep 或目录扫描推断源码实现，未执行构建、测试或安装。GitNexus 不可用不放宽该边界，因此 MCP 入口、传输层、鉴权、会话生命周期、消费者和完整影响范围全部未确认。

## 已完成动作与现场

- 用户已选择标准普通开发和当前工作区调研，继续使用当前分支。
- workspace-options 首次报告缺少工程资料忽略规则。按 CLI recovery 补齐 `.gitignore` 的五条规则和一条中文注释，第一次重试成功。
- 主 Agent 用 `git diff -- .gitignore` 确认改动范围，`git diff --check -- .gitignore` 通过。
- 当前已跟踪文件改动仅有 `.gitignore`，尚未修改业务实现。
- `git status` 另显示未跟踪的 `bash.exe.stackdump`，来源未核实，未读取、修改或删除，未将其列为本任务产物。
- 未提交、推送或回滚；编排状态仅由 CLI 维护。

## 目录更正与后续动作

用户随后将目录更正为 `D:\Downloads`。主 Agent 使用 Glob 在该目录按 `E2E_HTTP_MCP*.md` 定位到唯一候选：

```text
D:\Downloads\E2E_HTTP_MCP_BDE8A690E5A880E68BAFE5B38FE58C95E5808FE6B9A1%88.md
```

原子 Agent 已按更正路径读取全文 1009 行，需求提取完成。此前未提交 blocked 状态，调研节点交接前仍为 `in_progress`、revision=`1`。初次目录错误已消除，不再构成输入阻塞。

续办参数：task_id=`e2e-http-mcp`，state_path=`D:\workplace\typescript\e2e\docs\engineering\workflows\e2e-http-mcp-orchestration.yml`。交接命令应使用 CLI 最新返回的版本号。

## 文档需求要点

下列行号均指上述 `D:\Downloads` 文档，属于需求和设计断言，并非本次验证的源码事实。

- 第 15–24 行：Sidecar Gateway、MCP Proxy/Adapter、RunCoordinator 和最小核心补丁。Gateway 常驻，同 Key 首次请求按需创建临时 Runner，登录 Setup 一次，运行中可追加测试；默认 Worker 上限 4，空闲后回收。明确不引入 Git 同步、账号池、数据库、Redis、常驻 Worker 池、额外 REST 管理服务或跨 Run Session 持久化。
- 第 27–44 行：共享认证快照而非共享浏览器；区分 HTTP MCP Session、探索浏览器会话、Runner SessionStore。P0 包含 HTTP、鉴权、原生工具代理、脚本管理、动态执行、作业和报告、进程回收；OAuth、分布式、跨 Run 快照和精准取消属 P1。
- 第 70–83 行：AC-01 至 AC-12 覆盖多客户端、工具透传、会话隔离、登录一次、同 runId 动态追加、按需扩容、排队上限、清理、不同 Key 隔离、失败隔离、断线续行、按 jobId 报告和补丁基线回归。
- 第 231–297 行：Streamable HTTP，默认监听 `127.0.0.1:3001`，端点 `/mcp/e2e`，另有运维 `/healthz`；Bearer、工具权限、Host/Origin 白名单、可信反代限制。每个独立 MCP 会话拥有其 STDIO 子进程和浏览器会话，绑定认证主体并用心跳或 TTL 清理。透传四个原生工具及 `e2e://guide` 资源。禁止任意路径、命令、站点和未受控脚本；脚本执行带宿主权限，初期仅限受信任 Agent。
- 第 301–354 行：脚本位于共享 `tests/`，原子保存、文件互斥、防路径穿越和符号链接逃逸。原生收集会执行模块顶层代码，不受信任脚本收集需隔离。运行中覆盖不承诺已收集任务使用新内容。
- 第 360–404 行：RunKey 由项目、环境、完整 Origin 和账号组成，输入通过服务端 target 白名单解析。单 Gateway 实例配 KeyedMutex；STARTING 接受 pending，认证失败批量失败；DRAINING/STOPPING 的新请求进入后继队列，避免重复登录；默认空闲宽限 2 秒，seal 后不重新开放。
- 第 431–496 行：拟新增窄契约 `DynamicRunControl`，提供 submit、seal、shutdown；动态收集走原生 WorkUnit/依赖流程，保存 jobId 到 WorkUnit 的归属，重复文件有独立执行身份。核心补丁限动态收集入队、容量预留、调度唤醒、封口和动态报告。建议先以原型验证 A 运行中追加 B、扩 Worker 和完整报告。
- 第 500–573 行：单账号 `tester`，凭据由环境变量注入，每 Run Setup 一次；跨 Run 重新登录。认证过期封口或失败，不在运行中覆盖共享会话。OA 同 Token 多上下文并发须专项实测，失败降级为同账号串行。示例定位符和 URL 是待实际页面核验的占位内容。
- 第 579–696 行：六个新增工具为 list_test_scripts、get_test_script、save_test_script、run_test、get_test_status、get_test_report。run_test 异步返回 jobId；callerId、targetId、idempotencyKey 构成幂等范围。作业状态需区分收集、认证等待、运行和业务或基础设施失败；落盘原子且限访问主体，报告按 jobId 投影。IPC 使用版本化 Zod 校验、关联 ID 和 ACK，崩溃不自动重试有副作用测试。
- 第 766–839 行：部署建议 Windows 与 WSL2、非 root systemd、固定 Node/pnpm/Playwright 版本；日志脱敏、资源上限和失败恢复。第 884–959 行规定原型、实施工作包、交付物和上线门禁。第 932 行明确首选真正动态入队，批量窗口只在原型证明风险过高时另作决策。
- 第 1008 行：文档明确声明它是设计与实施规范，并非已实现或已通过编译测试的代码。

## 待澄清及待验证项

1. `run_test` 第 590 行包含可选 workers，而第 594 行建议 P0 固定服务端 maxWorkers=4、不接客户端值；需统一接口。
2. 需求基线第 89 行注明升级前重验；当前 main 起点 `d7c6b5e5` 和 `e2e@0.21.2` 的源码行为需逐条核对。文档的上游能力表不作为已验证事实。
3. MCP SDK 第 183、244–252 行的版本、包名和 API 组合需实际核验。
4. 实际 OA 环境、登录方式、凭据环境变量名、站点白名单、Bearer 发放与权限、探索会话 TTL 尚待配置；真实凭据不应写入规格或对话。
5. 同账号多上下文并发和真实业务操作需要环境验证；原型若证明核心动态补丁风险过高，切换批量窗口需明确用户决策。

## 文档公开的后续取证锚点

来自第 91–103、196–198、963–976 行，未由本节点验证存在性：

- `packages/e2e/src/mcp/server.ts`
- `packages/e2e/src/mcp/session.ts`
- `packages/e2e/src/run/runner.ts`
- `packages/e2e/src/run/scheduler.ts`
- `packages/e2e/src/run/units.ts`
- `packages/e2e/src/run/sessions.ts`
- `packages/e2e/src/run/public-ownership.ts`
- `packages/e2e/src/run/worker/handle.ts`
- `docs/authentication.mdx`
- `docs/reference/cli.mdx`

后续节点仍需遵守其公开的 required_files 和本地取证边界。

## 后续验证环境预检

主 Agent 检查到 Node 为 `v22.22.1`，低于包声明的 22 系列最低版本 `22.22.3`。`pnpm --version` 启动器执行失败，提示其指向的 pnpm 12.3.4 入口无法识别。尚未修改运行时、安装依赖或运行项目测试；这些是后续构建验证的待处理项。
