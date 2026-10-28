# 跨 run 共享登录会话规格

状态：需求边界与关键取舍已由用户在 grill-with-docs 阶段明确确认；规格与后续任务单仅保存在当前仓库；实现与验证状态待更新。

本规格基于 gitnexus-inquiry 调研记录、grill-with-docs 的 8 项决策（D1-D12）以及现有 runner 的调度与会话语义。术语以 `specs/shared-login-session/GLOSSARY.md` 为准。

## 问题说明

现有测试会话由 `test.setup` 产出、`{ session }` 消费，只在单次 run 内有效；run 结束后会话目录被删除。每个测试脚本因此需要自己登录，4 个 worker 并行时会对同一账号重复登录，带来账号互踢、验证码、限流和明显的启动开销；跨 run 更是每次从头登录。

测试作者真正需要的是：同一站点、同一账号的登录态由框架托管。第一次测试时登录一次，后续测试和后续 run 直接复用；登录失效时自动重新登录；4 个 worker 仍可并行跑不同文件；登录动作本身不能并发。

## 解决方案

在 target 上声明一份共享登录：`session: { account, login, check }`。框架在每个测试 attempt 开始时恢复上次保存的引擎状态并调用 `check`；有效就继续，无效就进入受跨进程锁保护的登录流程：重新确认、执行 `login`、验证、捕获状态并加密保存，然后继续测试。

共享状态按“站点身份 + 环境 + 账号”隔离，保存在项目根目录的 `.e2e/sessions/shared/` 下，跨 run、跨容器重建保留。状态用 AES-256-GCM 加密，密钥文件权限 0600，信封中不保存任何 secret 值或 taint。

测试可以用 `sharedSession: false` 关闭共享登录（用于测试登录流程本身）；显式 `{ session }` 和 `test.setup` 测试不注入共享登录。登录或校验抛错时整个 run 立即停止，只产生一条明确的错误。

一期只支持声明 `state` 能力的引擎（web 及自定义引擎）；mobile 引擎没有 capture/restore，配置 `session` 时在 config 加载阶段直接报错。

## 用户故事

1. 作为测试作者，我希望在 target 上声明一次账号、登录和校验钩子，以便不用在每个测试脚本里重复登录。
2. 作为测试作者，我希望登录钩子拿到 app、screen、platform 和账号凭据句柄，以便用现有 fixture 驱动登录页面。
3. 作为测试作者，我希望校验钩子只回答“当前是否已登录”，以便把登录判断集中在一处。
4. 作为测试作者，我希望第二次 run 直接复用上次的登录态，以便跨 run 不再重复登录。
5. 作为测试作者，我希望校验失败时框架自动重新登录，以便登录过期不需要人工介入。
6. 作为测试作者，我希望 4 个 worker 能并行使用同一份登录态，以便长测试文件不互相等待。
7. 作为测试作者，我希望并发 worker 同时发现登录失效时只有一个执行登录，以便不触发账号互踢或双重登录。
8. 作为测试作者，我希望抢到登录锁后先重新读取磁盘状态再校验，以便别的 worker 已经登录时直接复用而不重复登录。
9. 作为测试作者，我希望登录失败自动重试一次，以便偶发的页面抖动不直接终止 run。
10. 作为测试作者，我希望登录后立即校验一次，以便不会把无效状态当成有效状态保存下来。
11. 作为测试作者，我希望登录或校验钩子抛错时整个 run 立即停止并只报一条错误，以便不产生几十条重复失败。
12. 作为测试作者，我希望每个测试开始前都执行校验，以便同一 run 内登录中途失效也能被发现。
13. 作为测试作者，我希望 serial 组只做一次校验和登录，以便组内共享同一会话时不重复付出登录成本。
14. 作为测试作者，我希望用 `sharedSession: false` 关闭共享登录，以便测试登录流程本身。
15. 作为测试作者，我希望显式使用 `{ session }` 的测试完全不受共享登录影响，以便现有测试会话语义保持不变。
16. 作为测试作者，我希望 `test.setup` 测试不被注入共享登录，以便 setup 可以自己控制登录和保存。
17. 作为测试作者，我希望同一站点的不同账号各自保存登录态，以便多角色测试互不覆盖。
18. 作为测试作者，我希望不同 environment 的登录态互相隔离，以便测试环境和生产环境不串用。
19. 作为测试作者，我希望不同站点（identity 或 origin 不同）的登录态互相隔离，以便多站点项目不串用 cookie。
20. 作为测试作者，我希望 run 分配的端口变化不改变共享状态归属，以便每次 run 用不同端口仍能复用登录。
21. 作为测试作者，我希望修改 target 名称不改变共享状态归属，以便重命名 target 不必重新登录。
22. 作为测试作者，我希望状态损坏、身份不匹配或无法解密时自动冷启动重新登录，以便不需要手工删除文件。
23. 作为测试作者，我希望共享状态不设固定有效期，只由校验决定有效性，以便登录流程本身损坏时仍能复用有效缓存。
24. 作为测试作者，我希望删除 `.e2e/sessions/shared/` 就能强制重新登录，以便需要时有一条明确的逃生通道。
25. 作为安全审查者，我希望共享状态用 AES-256-GCM 加密且密钥文件权限为 0600，以便磁盘上的 cookie 不暴露。
26. 作为安全审查者，我希望共享信封不保存 secret 值和 taint，以便密码不会随登录态跨 run 落盘。
27. 作为安全审查者，我希望加密状态不进入模型输入、日志、报告或工件，以便维持现有 secret 不泄露不变量。
28. 作为用户，我希望 mobile target 配置 `session` 时在 config 加载阶段报错，以便不会误以为共享登录已生效。
29. 作为用户，我希望 app 没有 url 时配置 `session` 得到明确的配置错误，以便知道共享登录需要可寻址的应用。
30. 作为用户，我希望账号未配置时错误信息列出已配置账号，以便快速修正 credentials。
31. 作为用户，我希望引擎没有 state 能力时错误信息点名引擎，以便知道限制来自引擎而不是配置拼写。
32. 作为 MCP 用户，我希望通过 `run_test` 提交的测试也享受共享登录，以便远程提交的测试与本地 CLI 行为一致。
33. 作为 MCP 用户，我希望交互式 `open_session` 不自动注入共享登录，以便探索会话与测试状态互不影响。
34. 作为文档读者，我希望 authentication、config、test、errors 页面说明共享登录、`sharedSession` 和新错误码，以便不读源码也能正确使用。
35. 作为维护者，我希望共享会话信封有 schema 和有效/无效 fixture，以便 wire 变化在同一次评审中被发现。
36. 作为维护者，我希望 core 不 import 任何引擎实现，只用 public `state` 能力，以便引擎边界不被破坏。
37. 作为维护者，我希望共享登录函数不进入 config digest，以便修改登录脚本不会让 replay cache 失效；每次 attempt 的校验负责兜底。
38. 作为 Windows 用户，我希望锁与文件权限行为有明确说明，以便知道 0600 在 Windows 上只是提示位。
39. 作为部署者，我希望共享状态落在项目根 `.e2e` 卷上，以便容器重建后登录态仍在。
40. 作为使用 4 个 worker 的消费者，我希望删除测试脚本内的登录步骤后套件仍全部通过，以便验证共享登录真的替代了重复登录。

## 实施决定

### 配置面

- `Target` 增加可选的 `session: { account, login, check }`。键封闭，未知键报 `INVALID_CONFIG`。
- `account` 必须是非空字符串，并且存在于 `config.credentials`；错误信息列出已配置账号。
- `login(fixtures, credential)` 与 `check(fixtures, credential)` 都必须是函数；`fixtures` 提供 `app`、`screen`、`platform`，`credential` 是账号句柄，密码为 opaque `Secret`。
- target 声明 `session` 时，app 必须有 URL；否则报 `INVALID_CONFIG`。
- target 声明 `session` 时，引擎必须声明 `state.capture` 与 `state.restore`；否则报 `UNSUPPORTED_CAPABILITY`，错误信息点名引擎。
- `TestOptions` 增加 `sharedSession?: boolean`，默认 `true`，按现有选项层级合并（内层覆盖外层）。
- 显式 `session` 优先：测试声明了 `{ session }` 时不注入共享登录，现有 `TestSession.session?: string` 类型不改。
- `test.setup` 测试永不注入共享登录。

### 存储与密钥

- 共享状态根目录为 `<projectRoot>/.e2e/sessions/shared/`，不随 per-run output 删除；MCP job 的临时 output 清理不得触碰它。
- 存储键为站点身份、environment 与 account 的规范化摘要；站点身份缺失时用规范化 origin。端口和 target 名不参与。
- 每个键对应一个加密信封文件；密钥文件 `shared.key` 与信封同目录，内容为 32 字节随机密钥，权限 0600；目录权限 0700。
- 信封使用 AES-256-GCM；规范化信封 JSON 作为 AAD；写入使用同目录临时文件原子替换并设置 0600。
- 密钥文件缺失时生成新密钥；密钥长度不是 32 字节时 fail-closed 报 `SESSION_KEY_INVALID`，不静默重建。
- 共享状态不设 TTL；信封记录 `createdAt` 供诊断，不参与有效性判断。
- 信封解析失败、解密失败、站点/引擎/平台/应用身份不匹配时视为冷启动：忽略旧状态，登录成功后覆盖写入。
- 新增 wire 格式 `shared-session-1`，至少包含版本、存储键、账号、引擎身份、平台、应用身份、捕获时间与不透明的引擎状态；不包含 secret 值或 taint。schema、有效 fixture、无效 fixture 与生产者同一次变更提交。

### 登录流程

触发条件：target 声明了 `session`，当前 attempt 不是 setup，测试没有显式 `session`，且 `sharedSession` 不为 `false`。

1. 若磁盘上有可用状态，先恢复；调用 `check`。校验通过则直接继续，不取锁、不写文件。
2. 校验失败或没有状态时，获取该存储键的登录锁；等待超过超时时间报 `SESSION_LOCK_TIMEOUT`。
3. 持锁后重新从磁盘加载状态；若有则恢复；再次调用 `check`。
4. 仍然失败时调用 `login`；`login` 抛错时重试一次。
5. 登录成功后调用 `check` 验证；仍失败或抛错按登录失败处理。
6. 验证通过后调用引擎 `capture` 捕获状态，加密写入信封，释放锁，继续测试。
7. 释放锁必须在 finally 中完成；只有锁的持有者可以释放或接管。

- `login` 抛错且重试后仍失败，或登录后校验不通过，报 `SESSION_LOGIN_FAILED`。
- `check` 抛错报 `SESSION_CHECK_FAILED`。
- 以上错误都按 run 级失败处理：触发一次 run 中止，exit 2，剩余测试标记为跳过，不逐条重试登录。
- 锁超时属于基础设施故障，报 `SESSION_LOCK_TIMEOUT`，exit 3。
- 锁文件与信封同目录；使用独占创建（`wx`）；固定 10 分钟 stale，无心跳；过期锁可被接管。等待方使用有界重试与超时。

### 调度与并发

- 并发单位是 worker；一个 worker 同一时刻只执行一个 unit，一个 unit 是一个文件在一个 target 上的全部普通测试，或一个 setup 测试。
- 不同文件并行，上限为 run 的 `workers`、引擎声明的 `workers` 与 unit 数三者最小值；同一文件内的测试串行。
- 同一 target 的 setup 全部完成后才派发普通 unit；不同 target 共用 worker 槽位。
- serial 组共享一个 attempt 会话，组内成员串行；共享登录的校验与登录每个 group 只执行一次。
- 每个 attempt 的 `check` 可以并行；只有登录/重登动作被登录锁串行化。

### 引擎与平台

- core 只使用 `EngineHandle.state.capture/restore`，不 import 任何引擎实现。
- 恢复发生在 attempt 启动之后、测试 fixture 钩子与测试体之前；`login`/`check` 自己负责导航到需要的页面。
- mobile 引擎一期不支持；配置阶段 fail-closed，文档写明限制。
- 自定义引擎只要声明 `state` 能力即可使用共享登录。

### 安全

- 共享信封只保存引擎状态与身份元数据；不保存密码、其他 secret 值、secret 名称或 taint。
- 恢复后由当前 run 自己的 secret registry 与 ledger 负责脱敏；共享登录不跨 run 继承 secret 暴露级别。
- 密钥文件与信封均不得进入模型输入、日志、报告、工件或诊断；密钥不经 IPC 或环境变量传递。
- 状态可能包含 cookie，按敏感材料处理；信封必须加密，明文只在内存中存在。
- Windows 上文件 mode 只是提示位；文档说明其保护强度低于 POSIX，锁行为以实际测试为准。

### MCP 与宿主

- CLI run、MCP `run_test`、`openHost` 驱动的测试 attempt 都注入共享登录。
- `e2e mcp` 的交互式 `open_session` 不注入共享登录。
- worker、standalone attempt 与 in-process host 都从 projectRoot 重建共享存储；密钥从磁盘读取，不再走“密钥只在内存”的 IPC 路径。
- 共享目录锚定 projectRoot，不锚定 per-run output；MCP job 使用后删除 output 的行为不影响共享状态。

### 错误码与文档

- 复用：`INVALID_CONFIG`、`UNSUPPORTED_CAPABILITY`、`SESSION_KEY_INVALID`。
- 新增：`SESSION_LOGIN_FAILED`（configuration，exit 2）、`SESSION_CHECK_FAILED`（configuration，exit 2）、`SESSION_LOCK_TIMEOUT`（infrastructure，exit 3）。
- 新错误码必须同步 `docs/reference/errors.mdx`，并通过 `scripts/check-error-codes.ts`。
- 行为变更同一次变更更新 `docs/authentication.mdx`、`docs/reference/config.mdx`、`docs/reference/test.mdx`、`skills/e2e/references/` 与 `.changeset/`。
- changeset 按 0.x feature 记 patch。

### 兼容与摘要

- 现有 per-run `SessionStore` 不变；共享存储是独立机制。
- `digestTargets` 不加入 `session`：修改 `login`/`check` 不改变 config digest，也不使 replay cache 失效；每次 attempt 的校验负责兜底。此决定写入文档，避免后人当 bug 修。
- 不新增 CLI 清理命令；删除共享目录即可强制重登。

## 测试决策

接缝（用户已确认）：**集成优先 + 存储单测**。

好的测试只验证外部行为：真实 runner、真实配置、真实浏览器、真实文件系统；不直接断言内部函数调用。登录次数通过 fixture 应用的可观察计数（页面或接口）验证，而不是 spy。

### 集成测试

使用现有集成测试形态：临时项目 + 构建后的 runner + web 引擎 + Chromium，优先复用 `session-secrets`、`parallel-workers` 的夹具与写法。

1. 两次 run：第一次登录并保存，第二次恢复且 `check` 通过，登录计数保持 1。
2. 4 个 worker、无缓存或缓存失效：所有 worker 同时进入，只有一个执行登录，其余复用，登录计数为 1。
3. `check` 返回 false：重新登录，后续测试使用新状态。
4. `sharedSession: false`：不恢复、不登录，测试可以自己走登录流程。
5. 显式 `{ session }`：共享登录不恢复、不登录。
6. `test.setup`：共享登录不注入。
7. serial 组：组内多个成员只发生一次 `check`/登录。
8. 信封损坏或身份不匹配：冷启动重新登录，不报错。
9. 信封被篡改：解密失败，冷启动重新登录。
10. `login` 抛错且重试仍失败：run 以 exit 2 停止，只有一条 `SESSION_LOGIN_FAILED`，剩余测试跳过。
11. `check` 抛错：run 以 exit 2 停止，只有一条 `SESSION_CHECK_FAILED`。
12. 登录后 `check` 仍为 false：`SESSION_LOGIN_FAILED`，不写入坏状态。
13. mobile target 配置 `session`：config 加载阶段 `UNSUPPORTED_CAPABILITY`。
14. 多账号、多 environment、多站点：各自生成独立信封，互不覆盖。
15. 不同端口连续两次 run：复用同一份状态。
16. MCP `run_test` 使用共享登录；交互式 `open_session` 不注入。
17. 锁 stale：模拟过期锁后可接管；未过期锁不会被抢。
18. 锁等待超时：`SESSION_LOCK_TIMEOUT`。

### 单元测试

只覆盖集成难以稳定制造或观察的存储边界，沿用 `session-envelope` 单测的先例：

- 信封加密/解密、AAD 校验、篡改失败。
- 原子写入与 0600（POSIX 断言；Windows 只断言写入成功，不承诺 mode）。
- 缺少密钥时生成、密钥长度错误时 `SESSION_KEY_INVALID`。
- 信封中不出现 secret 值或 taint。
- 锁的获取、释放、stale 接管与等待超时。
- `shared-session-1` schema 的有效/无效 fixture。

### 先例

- `tests/integration/session-secrets.test.ts`：真实 runner + 秘密会话 + 篡改失败。
- `tests/integration/parallel-workers.test.ts`：多 worker 并发与调度行为。
- `tests/unit/session-envelope.test.ts`：信封加解密与 schema。
- `tests/unit/schema-fixtures.test.ts`：schema fixture 校验。
- `tests/types/sdk-types.ts`：公开 API 的编译期断言。

## 范围外

- mobile 引擎的共享登录（需要先补 state capture/restore）。
- 按账号/站点固定 worker（mod 运算）的粘性分配。
- `e2e mcp` 交互式 `open_session` 的共享登录注入。
- 新增会话清理 CLI、TTL、密钥轮换。
- 在共享信封中持久化 secret 值或 taint。
- 跨不同 projectRoot 共享登录态。
- 对现有 per-run `SessionStore` 的迁移或格式变更。
- 真实 OA、部署环境与生产账号的联调（实现完成后再做）。

## 补充说明

### 风险

- **锁的僵死**：固定 10 分钟 stale 意味着持有者崩溃后其他 worker 最多等 10 分钟；通过 `SESSION_LOCK_TIMEOUT` 让等待方尽快失败，避免无限挂起。
- **Windows 锁语义**：`wx`、rename 与打开文件的行为与 POSIX 不同；集成测试必须在 Windows 本地验证，不能只依赖 Linux CI。
- **密钥文件泄露**：0600 只是 POSIX 保护；备份、快照和容器卷权限仍需运维负责。密钥或信封不得进入日志与工件。
- **登录脚本变更**：不进入 config digest，旧 replay cache 不会因 `login` 改动而失效；每次 attempt 的 `check` 是兜底。文档必须写明。
- **登录后校验的成本**：每次冷启动多一次 `check`；这是避免缓存坏状态的代价，应在文档中说明。
- **MCP 容器**：共享目录必须落在 `/app/.e2e` 卷上；per-run output 的清理逻辑不得触碰。部署文件按用户要求不提交。

### 验收标准

- [ ] 两次 run 之间复用登录态，第二次不执行登录。
- [ ] 4 个 worker 并发冷启动时只登录一次。
- [ ] `check` 失效后自动重登，并保存新状态。
- [ ] `sharedSession: false`、显式 `session`、setup 三种场景都不注入。
- [ ] serial 组只校验/登录一次。
- [ ] 损坏、篡改、身份不匹配都冷启动；密钥损坏 fail-closed。
- [ ] `login`/`check` 抛错时 run 只产生一条错误并停止。
- [ ] mobile 配置 `session` 在 config 加载阶段报错。
- [ ] 新错误码、schema、fixtures、docs、skills、changeset 同步。
- [ ] `pnpm check`、`pnpm test`、`pnpm test:testbed` 通过；Windows 本地验证锁与权限行为。
- [ ] 消费者项目删除脚本内登录、恢复 4 worker 后套件通过。

### 调研与参考

- GitNexus 未索引本仓库，调研按 evidence_policy 降级为本地只读检索（source=local_search、authority=non_gitnexus），不能证明调用图与完整影响范围。
- `engineering/api` 与 `shared` 参考主题检索零命中；`grill/interaction/grill-question-partition.md` 已读取并用于分组。
- 完整调研记录见 `plans/shared-login-session-gitnexus-inquiry.md`；决策记录见 `plans/shared-login-session-decisions.md`。
