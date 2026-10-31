# 跨 run 共享登录会话调研记录

- 任务：`shared-login-session`
- 节点：`gitnexus-inquiry`
- 版本：`1`
- 工作区：`D:\workplace\typescript\e2e`
- 分支：`dev/e2e@0.21.2`（HEAD c70bd9cb）
- 记录时间：2026-10-28T（本地检索）

## 需求输入（已确认的设计，作为调研目标）

同账号+同网站（key = app identity + account）共享一份登录态，跨 run 持久化；框架托管登录生命周期：测试开始时恢复缓存状态 → `check` → 有效继续；无效则抢跨进程文件锁 → 二次确认 → `login` → `captureState` → AES-256-GCM 加密写入 `.e2e/sessions/shared/<hash>.json`（密钥 `.e2e/sessions/shared.key`，0600）→ 继续。4 worker 并行共用；登录/重登全局独占、失败重试一次；`login`/`check` 抛错按 run 级失败。测试选项 `sharedSession: false` 关闭共享；显式 `{ session }` 与 setup 测试不注入。与现有 per-run `SessionStore` 不复用；部署容器 `/app/.e2e` 为宿主机 state 卷。

## Spec 前置检查

`docs/engineering/specs/` 下不存在文件名前缀为 `shared-login-session` 的 spec（目录内仅 `e2e-http-mcp*`）。记录后继续。

## GitNexus 检索记录

1. `mcp__remote_gitnexus__list_repos`（limit 50，全量）：返回 36 个仓库（9ji 业务仓库等），`pagination.hasMore=false`，**不含本工作区 `D:\workplace\typescript\e2e`**。
2. `mcp__remote_gitnexus__query`（repo=`D:\workplace\typescript\e2e`，search_query=“跨 run 共享登录会话需要接入哪些配置解析、会话存储、执行调度与引擎状态能力”）：返回错误 `Repository is not available through this MCP server.`。

结论：GitNexus 服务可用，但本仓库未被索引——符合降级条件（仓库未索引）。以下全部为本地只读检索。

> **source=local_search、authority=non_gitnexus。** 本地证据（grep/read）不能证明调用图、完整影响范围或跨项目关系；下述“调用方”均由文本引用枚举，可能遗漏动态调用、字符串引用或 re-export 间接消费者。

## 本地检索记录（工具 → 命中）

| 检索 | 关键命中（file:line） |
|---|---|
| `rg "SessionStore"`（src） | run/sessions.ts（定义）、run/runner.ts:55,955,990、run/worker/entry.ts:205-209、run/worker/protocol.ts:68-70、run/standalone.ts:108,129,144、run/in-process.ts:38,176、run/execute.ts:59,106,573,631 |
| `rg "captureState\|restoreState"` | engine/surface.ts:201-203、engine/session.ts:355-356、run/execute.ts:637,999-1005、packages/web/src/engine.ts:146-148、packages/web/src/surface.ts:78,1052,1059 |
| `rg "sharedSession\|TargetSessionConfig\|SessionFixtures"` | types.ts:621-644,673,1219、config/targets.ts:12,22,176-177、collect/select.ts:19,144,159,200（**仅配置/选择层，run 层无命中**） |
| `rg -i "lock\|fileLock\|acquireLock"` | oauth/store.ts:96-124（跨进程 advisory 锁的唯一现成实现）；无通用 internal 锁模块 |
| `rg "sessionsRoot\|sessionKeyBase64"` | run/worker/protocol.ts:68-70、run/worker/entry.ts:208、run/runner.ts:990、run/sessions.ts:124-141 |
| `rg "layout\|outputLayout"` | run/output.ts:9-38（`sessions: <output>/sessions`）、run/runner.ts:955 |
| MCP HTTP：`rg "output\|\.e2e" src/mcp/http/jobs.ts` | jobs.ts:195-207（`.e2e/http-jobs`）、750（`output = runsDir/<uuid>`）、525-528（**run output 用后即删**） |
| `rg "SESSION_\|UNSUPPORTED_CAPABILITY" docs/reference/errors.mdx` | errors.mdx:144,152,158-162,181 |
| `rg "SessionStore\|SESSION_\|session-1" packages/e2e/tests` | tests/unit/session-envelope.test.ts、tests/helpers/session-schema.ts、tests/integration/{session-secrets,parallel-workers,cli-run,engine-contract,mcp-http-jobs,runner-lifecycle,sdk-dynamic-run}.test.ts、tests/unit/{select,scheduler,units}.test.ts |
| schema：`rg "required\|runId" schema/session-v1.schema.json` | schema/session-v1.schema.json:7-10（`runId` 必填且 uuidV7） |
| 工作树 diff：`git diff --stat` | 见下节“已落地范围” |
| `rg "STATE_FORMAT" packages/web` | web/src/surface.ts:78（`playwright-storage-state`）、1059（restore 校验 format/version） |
| `rg "state" packages/mobile/src/engine.ts` | engine.ts:22-66 的 `defineEngine` 无 `state` 能力 |

未命中项：`rg "shared\.key\|sessions/shared\|SharedSession"`（run 层）无任何命中——共享存储、锁、执行接入**尚未实现**；`rg "stateDir"`（mobile 仅指 agent-device 的目录选项，非引擎 state 能力）。

## 已落地范围（工作树，相对 HEAD 的未提交改动）

调研时工作树已包含以下实现，后续方案**不得重复**：

- `packages/e2e/src/types.ts:620-644`：`SessionFixtures`、`TargetSessionConfig`（account/login/check）已定义；`types.ts:673` `TestOptions.sharedSession?`；`types.ts:1214-1219` `Target.session?`。
- `packages/e2e/src/config/targets.ts:21-27,117-181`：`ResolvedTargetSession`（含 `credential` 句柄与 `key = canonicalDigest({app: identity ?? base.origin, environment, account})`，targets.ts:179）；`resolveSession` 校验：键封闭（`SESSION_KEYS`，targets.ts:118）、login/check 为函数、`app.base` 必须有 URL（targets.ts:154-159）、`engine.state.capture/restore` 必须存在否则 `UNSUPPORTED_CAPABILITY`（targets.ts:160-165）、account 必须在 credentials（targets.ts:166-173）。
- `packages/e2e/src/config/resolve.ts`（diff）：`resolveSecrets` 提前到 `resolveTargets` 之前，credentials 传入 target 解析。
- `packages/e2e/src/config/app.ts`（diff）：`TARGET_KEYS` 加入 `'session'`，未知键报错文案更新。
- `packages/e2e/src/secrets.ts:151-163`（diff）：`credentialHandle` 导出，供 targets 与 `credentials.user()` 共用。
- `packages/e2e/src/collect/select.ts:18-19,144,156-159,200`（diff）：`ResolvedTestOptions.sharedSession: boolean` 已按层合并（默认 true，innermost wins）。`WirePair.options` 即 `ResolvedTestOptions`（worker/protocol.ts:11,27），纯数据，可直接过 IPC。
- 部署侧（diff）：`deploy/http-mcp/compose.yaml:15` `./state:/app/.e2e` 卷（HEAD 已有），`Dockerfile:20` `mkdir /app/.e2e`，`--max-runs` 降为 1。

## 现有机制（跨 run 共享要接入的底座）

### per-run 会话（不复用，但模式照抄）

- `run/sessions.ts:116-319` `SessionStore`：内存 32 字节随机密钥（create，sessions.ts:132-134）、`forWorker` 校验长度否则 `SESSION_KEY_INVALID`（sessions.ts:137-142）、密钥经 IPC base64 传 worker（protocol.ts:68-70 `sessionKeyBase64`，注释“never disk or env”）、AES-256-GCM + 信封规范化 JSON 作 AAD（sessions.ts:209-215）、原子写 0600（sessions.ts:227，`internal/atomic-write.ts`）、解密 memoize + 每次 load 复查过期（sessions.ts:237-253）、`cleanup()` 删除 run 目录（sessions.ts:316-318）、`MAX_SESSION_AGE_MS = 24h`（sessions.ts:16）与 state 自带 `expiresAt` 取更早（sessions.ts:174-181）。
- `targetIdentity`（sessions.ts:36-45）：targetId/engine name+version+spiVersion/platform/appIdentity 六元组，恢复时逐一比对否则 `SESSION_MISMATCH`（sessions.ts:265-279）。
- 信封 `session-1`（sessions.ts:47-67）：`runId` 必填，schema `schema/session-v1.schema.json:7-10` 强制 uuidV7；`secrets` 值在密文内随行、`secrecy.names/taint` 明文认证（sessions.ts:57-58,75-79,200,212）。
- 流程：`test.setup` 声明 `sessions: [...]`（types.ts:705-710）→ `SessionStaging.stage` 契约（sessions.ts:85-113）→ setup attempt 里 `session.save(name)` → `captureState`（execute.ts:995-1013）→ attempt 通过后 `sessionStore.save`（execute.ts:572-573）→ 消费 attempt `launchSession` 在 `startAttempt` 之后、fixtures 之前 `load` + `adoptSecrecy` + `restoreState`（execute.ts:630-638）；restore 前已校验引擎 `state` 能力（execute.ts:599-605）。
- 编排：`run/runner.ts:955` 建 store，`990` + `exportKeyForWorker` 传 worker；`worker/entry.ts:205-209` `forWorker`；`in-process.ts:38,176` 直传引用；`standalone.ts:108` MCP/one-shot 每 run 新建并 `cleanup`（standalone.ts:129）。
- 布局：`run/output.ts:23-24,35` `sessions: <output>/sessions`，`output` = `--output`/config.output/`<projectRoot>/.e2e`（config/resolve.ts:75-76）；`OUTPUT_OWNED_DIRS = ['results','sessions','videos']`（resolve.ts:470）。

### credentials 与 secrecy

- `ResolvedCredential {name, username, password: ResolvedSecret}`（resolve.ts:38-44）；`resolveSecrets` 从 `credentials` + `E2E_USER_*` 解析（resolve.ts:828-870）；密码注册为 `<name>.password` secret，进 `allSecrets`（resolve.ts:96-101）。
- `credentialHandle`（secrets.ts:152-163）返回冻结句柄，password 是 `deferredSecret` 句柄（secrets.ts:120-140），值只在授权 fill 时经 `currentRegistry()` 解析——registry 由 `withConfigSecretReferences`/`holdSecretRegistry` 在安装 config 的进程内持有（secrets.ts:36-85）。
- digest：credentials 以脱敏形式进 config digest（resolve.ts:1065-1073）；`digestTargets`（targets.ts:211-229）**只取 name/platform/engine/declaredApp，不含 `session`**——login/check 函数与 account 名不进 digest（account 只进 `key`，targets.ts:179）。
- 安全不变量（AGENTS.md Gotchas）：secret 永不进模型输入/digest/日志/报告/工件；文本下载按 ledger 重写（`run/secrecy.ts` `redactsDownloads`）；invariant 测试在 `tests/integration/agent-policy.test.ts` 与 secret-ledger 单测。

### 引擎 state 能力

- 契约：`engine/index.ts:286-291` `EngineStateCapability {capture, restore}`，`surface.ts:201-203` `captureState/restoreState`，manifest 能力组 `state: ['capture','restore']`（engine/manifest.ts:49）。
- web：`packages/web/src/engine.ts:146-148` 声明 state；capture 产出 `{format:'playwright-storage-state', version:1, data: storageState}`（web/src/surface.ts:78,1052），restore 校验 format/version（1059），经 `context.replace(storageState)` 重建 context（web/src/attempt-session.ts:341-346）。
- mobile：`packages/mobile/src/engine.ts:22-66` 的 defineEngine **无 `state`**。→ 现实现下 `mobile()` target 配 `session` 在 config load 即 `UNSUPPORTED_CAPABILITY`（targets.ts:160-165）。共享登录目前只对 web()（与任何声明 state 的自定义引擎）可用。

### 调度/worker/serial

- `AttemptContext` 封闭联合：`ordinary | setup(staging) | serial(shared)`（execute.ts:166-170）。serial 组一次 attempt 一个共享 session（run/serial.ts:1,27,424-426,483,531），成员经 execute.ts:975-977 `shared?.session ?? launchSession(...)` 复用。
- worker 各自重新解析 config 模块（含函数）并校验 `configDigest`（protocol.ts/entry.ts；resolve.ts:342 注释“同一 config 与 ports……identities 与 digest 成立”）。
- setup 失败跳过其 session 消费者：`setupFailedSkip`（units.ts:127-131）。

### MCP HTTP job 与部署保留

- `src/mcp/http/jobs.ts`：job 根 `root/.e2e/http-jobs`（195），每次 run `output = runsDir/<uuid>`（750），产物归档进 job store 后 **`rm(run.output)`**（525-528）。per-run `sessions/` 在此 output 下 → 随 output 删除，MCP job 现状不保留任何会话。
- 容器：`deploy/http-mcp/compose.yaml:15` 把宿主机 `./state` 挂到 `/app/.e2e`，卷在容器重建后保留；`Dockerfile:20` 预建目录并 chown node。project root 即 `/app`，故 `<projectRoot>/.e2e/sessions/shared/` 落在卷上，跨 run、跨重建保留——**前提是共享存储锚定 projectRoot 而不是 per-run output**。

## 影响面（新增实现将触及的符号与必改文件）

1. **新持久化存储**（建议 `packages/e2e/src/run/shared-sessions.ts`）：
   - 锚点 `<projectRoot>/.e2e/sessions/shared/<key>.json` + `shared.key`（0600，`writeFileAtomic`）。不能走 `outputLayout.sessions`（output.ts:35；MCP job 下是 uuid 临时目录，jobs.ts:750,525-528）。
   - 信封照抄 sessions.ts 模式但 `runId` 换成 `key`/`account` → 需要新 wire schema `shared-session-1`：`schema/shared-session-1.schema.json` + valid/invalid fixtures（`schema/fixtures/`）+ `tests/helpers/session-schema.ts`、`tests/unit/session-envelope.test.ts`、集成里对 envelope 的校验（AGENTS.md：schema、双 fixture、producer 同一 review）。
   - 复用/改造的符号：`SessionEnvelope`/`SessionPayload`/`SavedSession`/`SavedSecrecy`（sessions.ts:47-79,14）、`fileNamePart` 防注入（sessions.ts:341-350）、`targetIdentity`（sessions.ts:36）——共享信封的 engine/platform/appIdentity 校验语义完全适用。
2. **跨进程锁**：`oauth/store.ts:101-124` 的 advisory 锁（`wx` 独占创建、10s stale、rename 抢占、5s 等待）是唯一现成实现，但是 `FileCredentialStore` 私有方法。落点：提取为 `internal/` 共享工具或在共享存储内实现同模式；stale 阈值必须覆盖 login 时长（见风险 R2）。
3. **runAttempt 接入点**（execute.ts）：
   - `SessionPlan`（execute.ts:155）扩为可携带“恢复共享状态”的来源；`launchSession` 的恢复分支（599-638）改为二选一：显式 `plan.session` 走 `SessionStore.load`，否则 `pair.options.sharedSession && this.target.session` 走共享存储 load。显式 `session` 优先（types.ts:671 注释已成契约）。
   - check/login 需要 `SessionFixtures`（app/screen/platform）：fixtures 在 execute.ts:1014 `createFixtures` 才生成，且 `context.kind==='setup'` 已有分支（995-996）——建议插入点在 fixtures 就绪后、`beforeEach`/body 之前（execute.ts:1014-1041 区间）：check(fixtures, credential) → false 则 锁 → 重载共享状态二次确认/重 restore → login(fixtures) → `session.captureState`（模式同 999-1012，携带 `carriedSecrecy`）→ 共享 save → 继续；抛错按 run 级失败。
   - serial：一个 group attempt 只 check/login 一次（shared 分支 execute.ts:975-977、serial.ts:424-426）；setup 不注入（context.kind==='setup'）。
4. **runner/worker/standalone 布线**：`SessionStore.create/forWorker` 旁新增共享存储的构造；standalone.ts:108-129 与 open-session/in-process 各 host 路径都要能 load（key 文件从盘读，密钥不再走 IPC“never disk”约束——共享 key 按设计落盘 0600，需评估对既有“内存密钥”不变量测试 `agent-policy.test.ts` 的例外声明）。
5. **选择/选项**：`select.ts` 已合并 `sharedSession`；确认 `tests/unit/select.test.ts` 无整对象 toEqual 断言（抽查为字段级断言，风险低）。
6. **digest**：`digestTargets` 不含 session（targets.ts:211-229）是现状——login/check 改动不使 replay cache/config digest 失效，可接受（每次 attempt 跑 check 兜底），但需在 docs/engineering 决策记录一句，防后人当 bug 修。
7. **错误码**：`scripts/check-error-codes.ts`（扫描 E2EError 字面量，对照 errors.mdx/engine.mdx）——新码必须同 PR 进 `docs/reference/errors.mdx`（现有邻近条目 errors.mdx:158-162,181）。可复用：`SESSION_UNAVAILABLE/SESSION_MISMATCH/SESSION_EXPIRED/SESSION_INVALID/SESSION_KEY_INVALID/UNSUPPORTED_CAPABILITY/INVALID_CONFIG`；预计需新增（命名待定）：登录/校验钩子失败（run 级）、锁等待超时。
8. **文档与 skill 同步**（AGENTS.md Contracts）：`docs/authentication.mdx`（现“Sign in once in a setup test”/“Session rules”，15,68 行起，新增共享登录节）、`docs/reference/config.mdx`（target 键 271/408-425、`.e2e` 目录表 597-598 需加 `sessions/shared/`）、`docs/reference/test.mdx`（`sharedSession` 选项）、`docs/reference/engine.mdx`/`errors.mdx`（新码）、`skills/e2e/references/setup.md`、`writing-tests.md`。
9. **类型面**：`packages/e2e/tests/types/sdk-types.ts`（522 行附近有 setup 断言）应加 `Target.session` 必填 account/login/check、`sharedSession?: boolean` 的编译断言；`packages/e2e/dist/index.d.ts` 是公开 API，随 types.ts 生效。
10. **测试**：新增单测（resolveSession 校验、共享信封/加解密、锁）与集成（跨两个 run 复用登录、4 worker 并发只登录一次、check=false 重登、`sharedSession:false`/显式 session/setup 三种不注入、篡改 key 文件失败关闭）；受影响现有集成：`session-secrets.test.ts`、`parallel-workers.test.ts`、`mcp-http-jobs.test.ts`、`runner-lifecycle.test.ts`、`cli-run.test.ts`、`engine-contract.test.ts`。`apps/testbed` 需要共享登录 playground 路线（Definition of done：built CLI 验证）。
11. **changeset**：用户可见变更，需 `.changeset/`（0.x 下 feature 为 patch）。

## 风险与未确认项

- **R1（未确认）**：mobile 引擎无 `state` 能力（mobile/src/engine.ts:22-66）——共享登录第一期事实上 web-only；配置层已 fail-closed（targets.ts:160-165），文档必须写明，或给 mobile 补 state capture/restore（agent-device 是否有对应 API 未查证）。
- **R2**：oauth 锁 stale=10s（oauth/store.ts:33）远小于一次 login（navigate+form 填，常 >30s）。login 期间锁持有人不发心跳，另一 worker 可 rename 抢锁 → 双登。共享锁的 stale 必须绑定“持有者可证明存活”（心跳 touch mtime 或写 pid+存活检查），或等待超时随 `launchTimeout`。
- **R3**：`restoreState` 在 `startAttempt` 之后、fixtures 之前执行（execute.ts:613-638）——安全；但 check 返回 false 后在同一 attempt 页面上直接 `login` 意味着页面可能已 restore 出半失效态。设计“二次确认”需定义确认对象（重新 load 磁盘状态再 restore，还是就地再 check），否则并发两个 worker 各自 check=false 依次登录后会 capture 两次（后写覆盖前写，行为正确但多花一次登录，可接受需注明）。
- **R4**：跨进程锁与原子 rename 在 Windows 的语义（Node `openSync('wx')`/`renameSync` 对另一进程持开文件的锁定差异）。oauth/store 已有同款先例在 CLI 用，未在本框架测试矩阵（CI Linux+macOS+Windows? 见 spec.yml：Node 矩阵跑 `pnpm test`）验证过共享锁；Windows 文件 mode 0600 仅是提示位，`shared.key` 的保护强度在 Windows 低于 POSIX。未确认，需实现时以集成测试在 Windows 上验证 fail-closed。
- **R5**：worker 内调用 login 时 `credential.password` 是 deferred 句柄，取值依赖进程内 secret registry（secrets.ts:120-140 + `holdSecretRegistry`）。worker 重新解析 config 时会安装 registry（entry.ts 路径），但 login 执行时刻 registry 是否仍 live 未逐行确认（`holdSecretRegistry` 的释放时机）——未确认项。
- **R6**：24h 上限语义（sessions.ts:16,174-181）是 per-run store 的；跨 run 状态若照抄 TTL，缓存会在两天后必然 `SESSION_EXPIRED`，与“check 决定有效性”的设计冲突。共享信封的 `expiresAt` 策略（省略？取 state 声明？远大于 24h？）需要显式决策。
- **R7**：与显式 session 的优先级：types.ts:666-673 注释已定（显式 `session` 从不使用共享；`sharedSession:false` 退出登录流）。execute 接线时必须保证“显式 session 的 load 失败走 `SESSION_UNAVAILABLE`（setup 未产出）”与“共享 load 未命中是冷启动（login）而非错误”两条路径不混——语义不同，错误码归属要分别写进 errors.mdx。
- **R8**：secrecy 绑定：payload 携带 secret 值与 taint 行（sessions.ts:57-58,212）；跨 run 意味着 taint/secret 值持久化进密文——AGENTS.md 不变量“会话载荷不进诊断、run 结束删除”是为 per-run 写的；共享存储需要新的不变量测试（密钥文件 0600、密文外 envelope 只含 names/tainted、`shared.key` 绝不进报告/日志），并核对 `agent-policy.test.ts` 与 secret-ledger 测试的既有断言是否会被持久 key 触发。
- **R9**：MCP HTTP 单容器 `--max-runs 1`（Dockerfile diff）降低并发登录压力，但 4 worker 在同一 run 内仍并发；`jobs.ts` 的 output 删除逻辑不会碰 `projectRoot/.e2e/sessions/shared/`，前提是共享目录确实锚定 projectRoot——落点若误用 `layout.sessions` 会随 job 清理丢失（jobs.ts:750,525-528）。
- **未确认项**：digest 不含 session 函数是否会让“改 login 后旧 replay 记录失配”类问题被 `REPLAY_STALE` 捕获（strict cache 语义只针对 agent 步骤，login 钩子不在其内）；`e2e mcp` live session（standalone/open-session）第一期是否注入共享登录——设计文本只说“测试开始时检测”，未覆盖 live session，建议主 Agent 与用户确认范围。

## 结论与落点建议

可行。配置/类型/选择层（含部署卷）在工作树已就位且校验完整（fail-closed）；缺口全部集中在 run 层与周边契约：

1. 新增 `packages/e2e/src/run/shared-sessions.ts`（共享存储 + 存活可证锁），信封模式抄 `run/sessions.ts`，锁模式提干自 `oauth/store.ts:101-124`（R2 修 stale）。
2. 改 `packages/e2e/src/run/execute.ts`：`SessionPlan`/`launchSession`（155,585-658）二选一恢复源；`runAttempt` fixtures 后（约 1014-1041）插入 check→锁→login→capture→save；serial 每 group attempt 一次（975-977,`run/serial.ts:424`）。
3. 改 `run/runner.ts:955,990`、`run/worker/protocol.ts:68`、`run/worker/entry.ts:205`、`run/in-process.ts`、`run/standalone.ts:108`：共享存储按 projectRoot 锚定构造，key 从 `shared.key` 读。
4. `schema/shared-session-1.schema.json` + fixtures + `tests/helpers/session-schema.ts`。
5. 文档同 PR：`docs/authentication.mdx`、`docs/reference/config.mdx:597`、`docs/reference/test.mdx`、`docs/reference/errors.mdx`（新码，过 `scripts/check-error-codes.ts`）、`skills/e2e/references/{setup,writing-tests}.md`、`tests/types/sdk-types.ts` 断言、`.changeset/`。
6. 测试：`tests/unit/select.test.ts` 补 sharedSession 合并断言；新增共享流集成（两 run 复用、并发独占、三不注入、篡改失败关闭、Windows 锁行为 R4）。
