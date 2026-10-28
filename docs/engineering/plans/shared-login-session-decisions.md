# 共享登录会话决策记录

- 任务：`shared-login-session`
- 阶段：`grill-with-docs`（2026-10-29）
- 输入：`plans/shared-login-session-gitnexus-inquiry.md`、前序 grilling 问答

## 已确认决策

| 编号 | 决策 | 依据 |
|---|---|---|
| D1 | 采用共享会话 + 登录独占；不做“同账号+同站点固定 worker（mod 4）” | 4 worker 并行吞吐最高；check 通过即可直接使用，只有登录/重登需要串行 |
| D2 | 一期只支持本仓库内声明 `state` 能力的引擎（web 及自定义引擎）；mobile 配置 `session` 在 config 加载时 fail-closed 报错 | mobile 引擎当前没有 capture/restore，静默跳过会让用户误以为已生效 |
| D3 | 关闭共享登录的测试选项命名为 `sharedSession: false` | 不把现有 `TestSession.session?: string` 扩成 `string \| false`，避免贯穿 selection、调度与报告 |
| D4 | 共享会话状态不设固定 TTL，只由 `check` 决定有效性 | TTL 会在登录流程本身损坏时，让本来有效的缓存也不可用，与“测试时自动检测”冲突 |
| D5 | 登录锁使用固定 10 分钟 stale，不做心跳；等待方按超时失败 | 绝不抢一个可能还活着的登录锁；实现最简，崩溃恢复代价可接受 |
| D6 | 抢到锁后重新加载并恢复磁盘状态、再执行一次 `check`；仍无效才 `login` | 避免两个 worker 各自登录、后写覆盖前写 |
| D7 | 测试 attempt（含 MCP `run_test` 提交的测试）注入共享登录；`e2e mcp` 的交互式 `open_session` 不注入 | 共享登录只服务测试；交互式探索保持现状，范围最小 |
| D8 | `login`/`check` 抛错按 run 级失败：整个 run 立即停止（exit 2），只产生一条错误；`login` 失败重试一次 | 复用现有 run 级中止，不产生逐测试的重复失败 |
| D9 | 每个测试 attempt 开始前做 check；serial 组每个 group 只做一次；setup 测试与显式 `{ session }` 测试不注入 | 与现有调度单元和测试会话语义对齐 |
| D10 | 共享状态锚定 `<projectRoot>/.e2e/sessions/shared/`，AES-256-GCM，密钥文件 0600；信封只存引擎 state 与元数据，不持久化 secret 值或 taint | MCP job 的 per-run output 用后即删；恢复后由当前 run 的 ledger 负责脱敏 |
| D11 | 不新增清理命令；需要强制重登时删除 `.e2e/sessions/shared/`，文档写明 | YAGNI；删除目录即可完成清理 |
| D12 | 存储键 = 站点身份（identity，缺失时用 origin）+ environment + account；不含 run 端口与 target 名 | 端口每次 run 可能不同，target 名可改，两者都不应改变共享状态归属 |

## 非目标

- mobile 引擎的共享登录（需要先补 state 能力）。
- 固定 worker / mod 运算的粘性分配。
- `e2e mcp` 交互式会话的共享登录注入。
- 新增会话清理 CLI。
- 共享会话状态中保存 secret 值或 taint。

## 后续阶段硬约束

- 共享目录必须由 projectRoot 推导，不能用 `outputLayout.sessions`。
- 登录/重登的跨进程锁只覆盖登录动作，不覆盖整个 attempt。
- 新错误码必须同步 `docs/reference/errors.mdx`，并通过 `scripts/check-error-codes.ts`。
- 新增 wire 格式（共享会话信封）必须同时更新 schema、valid/invalid fixture 与生产者。
- 行为变更同 PR 更新 `docs/authentication.mdx`、`docs/reference/config.mdx`、`docs/reference/test.mdx`、`skills/e2e/references/` 与 `.changeset/`。
