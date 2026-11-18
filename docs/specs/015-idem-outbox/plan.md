# 015 · 实现计划

- 关联：`spec.md`（FR-001 ~ FR-010）
- 结论：用 SQLite 里的一张 `effects` 表做 Outbox，`EffectQueue` 负责扫描、退避、重放；交付与回帖都改成「先入队，再立即尝试一次」。

## 1. 技术决策

| 决策 | 选择 | 依据 | 需求 |
| --- | --- | --- | --- |
| 存储 | 复用现有 SQLite（`store.ts` 的 schema） | 单机单进程，已有 WAL 与迁移路径；引入 broker 是额外运维面 | FR-001 |
| 幂等键 | `UNIQUE(kind, key)` + `INSERT OR IGNORE` | 数据库约束而不是内存判断，重启/多入口都成立 | FR-002 |
| 键的组成 | push=`分支@提交号`、pr=`别名:分支`、comment=`仓库#编号:pr\|issue:任务号` | 键必须描述「这次外部副作用」，不能用任务号：同一任务可以有多次推送、多个回帖目的 | FR-003 |
| 执行模型 | 入队后立刻 `runNow`，失败留在队列由定时器接管 | 保持「正常路径同步返回结果」的现有行为，只在失败时转为异步 | FR-004 |
| 结果 | `result` 列存字符串；重放读到已完成直接返回 | 崩溃点在「远端成功、本地未写」时，第二次执行前先读库即可消除重复 | FR-005 |
| PR 兜底 | 执行前 `gh pr list --head <分支>`，命中则复用 | 崩溃可能发生在 `gh pr create` 之后、`markEffectDone` 之前，键里没有 PR 号可查 | FR-006 |
| 退避 | `min(2s × 2^(attempts-1), 60s)` | 与改进项给出的区间一致；无随机抖动，测试可断言时序 | FR-007 |
| 扫描 | `setInterval` 1s 调 `runDue`，`draining` 标志防重入 | 单进程，无需租约；与 `fill()` 的轮询风格一致 | FR-008 |
| 记账 | `onDone` 回调里写 `task_effects` | 账本语义是「仍在生效的副作用」，失败的动作还没生效 | FR-009 |
| 推送失败语义 | 不抛错，`pushed=false`，任务照常成功 | 代码改动已提交且有分支，任务是成功的；这与现有「PR 失败不影响任务」一致，并让重试真正有机会发生 | FR-010 |

## 2. 数据模型（`effects`）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | 扫描顺序 |
| `kind` | TEXT | `push` / `pr` / `comment` |
| `key` | TEXT | 去重键，与 `kind` 唯一 |
| `payload` | TEXT | 首次入队时冻结的 JSON |
| `attempts` | INTEGER | 失败次数 |
| `next_at` | INTEGER | 下次可执行时间（ms） |
| `last_error` | TEXT | 最近一次失败摘要，截断 500 字符 |
| `result` | TEXT | 成功结果（PR 链接 / `posted` / `skipped`） |
| `created_at` / `done_at` | INTEGER | `done_at` 非空即已完成 |

索引：`(done_at, next_at)` 服务到期扫描。

## 3. 模块划分

- `src/effects.ts`（新）：`EffectQueue`、`effectDelay`、三个 payload 类型、`deliveryEffectHandlers`（push/pr 的具体执行）、`findPrForBranch`。
- `src/store.ts`：`enqueueEffect`、`effectByKey`、`dueEffects`、`markEffectAttempt`、`markEffectDone`。
- `src/deliver.ts`：`deliver()` 只做「提交 + 入队 + 立即尝试 + 组装结果」，不再直接调 `pushBranch` / `createPr`。
- `src/router.ts`：构造 `EffectQueue`（注入 `now`、delivery handlers、`comment` handler、`onDone` 记账）；`replyToSource` 改为入队；`start()/stop()` 同时管定时器。
- `src/git.ts`：`createPr` 参数收敛为 `CreatePrOptions`。

`comment` handler 依赖 Router 的日志与去重回帖（`postReplyOnce`），所以在 Router 内实现，避免把信道路径搬进 `effects.ts`。

## 4. 错误语义

- handler 抛错或返回非零 → `markEffectAttempt`：`attempts+1`、`next_at = now + delay`、`last_error` 落库；调用方（交付）看到 `ok:false`。
- handler 返回空字符串 / 空链接视为失败（PR 创建无输出）。
- 未注册的 kind、payload 解析失败也按失败处理并写 `last_error`，不吞掉。
- 网络类失败与逻辑类失败一视同仁，都走退避；持续失败由 `last_error` 与 `attempts` 暴露。

## 5. 测试策略

- 单元（`tests/effects.test.ts`，内存库）：入队幂等、结果缓存、7 次退避序列、跨实例接管、`onDone` 时机、未注册 kind。
- 集成（同一文件 + 真实 git 仓库）：真实 `pushBranch` 失败与恢复、PR 崩溃重放复用已有 PR、同一任务二次交付只建一个 PR。
- 回归（`tests/github-comments.test.ts`）：交付与既有 PR 更新路径注入队列后行为不变。
- 冒烟（临时脚本，不提交）：真实 `Router` + 文件库，回帖失败入队，重启新进程后由定时器重放成功且只发一次。
