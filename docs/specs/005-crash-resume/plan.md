# 005 · 实现计划

- 输入：`spec.md`
- 约束：不新增 tasks 表列；不修改 `extensions/pisa-worker.ts`；不动 `scripts/`

## 1. 技术决策

| 决策 | 结论 | 依据 |
| --- | --- | --- |
| 状态存储 | 只在 `TaskStatus` 与 `ALLOWED` 增加 `paused`，tasks 表复用 `status` 文本列 | 表结构不变，SQLite 无枚举约束；迁移成本为零（FR-001） |
| 工作副本定位 | 由 `resolve(stateDir, "worktrees", task.id)` 推导，不落库 | 路径是任务号的纯函数，多一列就多一处可失效的副本（FR-002） |
| 可恢复判定 | 工作副本目录存在且 `sessionId` 非空 | 缺工作副本无处执行，缺会话无法续上下文（FR-002） |
| 分流位置 | `Router.recoverInterrupted()`，启动时由 `index.ts` 调用，取代 `store.markOrphansFailed` | 判定要用 `cfg.stateDir` 与文件系统，属于 Router 的编排职责；Store 只做单条状态写入 |
| 恢复入口 | 复用现有命令解析：新增 `resume` 命令与私聊 `/resume` | 与 `continue`/`cancel` 同一套鉴权与回执路径（FR-003/004） |
| 恢复执行 | `paused → running` 后直接进入 `runTask`，注册到 `active` 表 | 复用并发与取消机制；`drainOnce` 仍能等到它（FR-005/008） |
| 工作副本复用 | `runTask` 先看目录是否存在，存在则跳过 `createWorktree` | 工作副本与分支都要保留原状（FR-005） |
| 会话恢复 | `AdapterInput.resumeSessionId`，`OmpAdapter` 在 `--mode=json` 之前插入 `-r <id>` | 参数顺序与现有 omp 调用约定一致，适配器之外不出现 omp 细节（FR-006） |
| 恢复标记 | `AdapterInput.resume` 独立于 `resumeSessionId`，由 `runTask` 是否复用工作副本决定 | 没有会话 id 的 paused 任务同样要拿到核对提示（FR-006） |
| 提示词 | `buildPrompt` 按 `resume` 开关追加固定核对段：目录与 `git status`/`git log`、分支推送与 PR 存在性、外部动作去重 | 提示词属于适配器职责（FR-006） |
| 放弃中断任务 | `cancel` 命令接受 `paused` 状态 | 状态机允许 `paused → cancelled`，不另开命令（FR-001） |

## 2. 影响面

- `src/types.ts`：状态枚举与跃迁表
- `src/config.ts`：命令解析新增 `resume`
- `src/store.ts`：删除 `markOrphansFailed`，新增按状态取任务
- `src/router.ts`：启动分流、恢复命令、`runTask` 复用工作副本
- `src/worker.ts`、`src/adapters/*`：会话恢复参数与提示词
- `src/index.ts`：启动分流替换旧清理
- README 用法、003/002 文档中指向旧行为的句子

## 3. 测试策略

- 状态机：单测覆盖合法与非法跃迁（无 IO）
- 适配器：参数顺序与提示词内容的纯函数断言
- Router：临时 git 仓库 + 假 Worker，验证启动分流与恢复全链路（假 Worker 记录是否复用了工作副本）

## 4. 风险

- 恢复任务的 `branch` 若为空（历史数据），`runTask` 退回 `pisa/<任务号>`，与交付逻辑一致，不另做兼容
- 并发已满时恢复请求被拒绝，请求者稍后重试；不排队，避免恢复语义与排队语义混在一起
