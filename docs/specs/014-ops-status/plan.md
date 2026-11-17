# 014 · 实现计划

- 输入：`spec.md`
- 约束：不新增依赖；不动 `extensions/`；巡检不写任务库（不改 `docs/specs/009` 的投递链路）

## 1. 技术决策

| 决策 | 结论 | 依据 |
| --- | --- | --- |
| 检查执行位置 | 独立的 `pisa status` 进程，不在守护进程内起定时器 | 进程卡死时进程内定时器一起停，检测不到自己；退出码要能被 launchd 与脚本消费（FR-001、US-2） |
| 存活判定 | 守护进程每 30 秒写 `heartbeat` 文件，检查方看 mtime，超过 180 秒算过期 | 只差一次文件 mtime，比 pid 探测能同时发现「卡死」与「未运行」（FR-003、FR-007） |
| 检查实现 | `src/health.ts` 的 `inspect({ cfg, configFile })` 返回 `{ code, problems, checkedAt }` | 纯函数式、无副作用，CLI 与测试共用同一个判定源（FR-001…FR-006） |
| 问题标识 | 每个问题带稳定 `key`（如 `heartbeat-stale`、`repo-missing:<别名>`），消息另存可读文本 | 去重签名基于 key，避免把「已过期 61s / 62s」当成新问题刷屏（FR-009） |
| 任务库检查 | 存在则以 `readonly` 打开并 `SELECT COUNT(*) FROM tasks`；心跳新鲜但库不存在也算部件错误 | 只读打开不会与守护进程抢写锁；缺库说明状态目录被破坏（FR-004） |
| 去重状态 | `.pisa/ops-alert.json` 存 `{ signature, at }`；正常时删除 | 巡检每小时是独立进程，内存变量无法跨次去重；删除即「恢复清零」（FR-009、FR-013） |
| CLI 入口 | 新增 `src/cli.ts`（`bin.pisa`），子命令 `status`；`src/index.ts` 仍是守护进程入口 | 启动参数与常驻生命周期不混进状态检查；`pisa` 成为唯一对外命令名 |
| 巡检触发 | `scripts/ops-check.sh` 载入 token 后 `exec bun run src/cli.ts status --alert`，由 launchd `ai.pisa.opscheck` 的 `StartInterval 3600` 驱动 | 复用现有 launchd 安装脚本与 token 文件约定；小时数是运维配置，不进业务配置（FR-008、非目标） |
| 推送 | 复用 `TelegramChannel.send`，目标 `scheduler.chatId` → 探针 `chatId` → `webhook.chatId`，没有 token 或目标时不发 | 不新增通道实现、不新增配置项（FR-010、FR-011） |
| 未知参数 | 打印用法，退出 `64` | 与四种状态码区分，脚本不会误判为健康（FR-014） |

## 2. 影响面

- `src/health.ts`（新增）：退出码判定、心跳写入、去重、报告渲染
- `src/cli.ts`（新增）：`pisa status [--alert]` 与用法
- `src/index.ts`：启动写心跳，关停停心跳
- `package.json`：`bin.pisa`
- `scripts/ops-check.sh`（新增）、`scripts/install-launchd.sh`：每小时巡检的 launchd job
- `README.md`：`pisa status`、退出码表、巡检与日志位置
- `docs/specs/014-ops-status/`：spec / plan / tasks

## 3. 测试策略

- `inspect`：临时目录构造四种状态（缺配置、坏部件、无心跳、全正常），断言 `code` 与问题 `key`
- 心跳过期：写入心跳再用 `utimesSync` 把 mtime 拨老，断言 `1`
- 去重：`shouldSpeak` 连续调用断言「说 → 不说 → 恢复清空 → 再说」，状态文件放在临时目录
- CLI 端到端：`bun src/cli.ts status` 子进程断言退出码 0/1/2/3；`--alert` 断言正常时 stdout 为空、同一异常第二次为空
- 现有测试全部保留：不修改 `src/router.ts` 等既有路径，只新增心跳写入

## 4. 风险

- 心跳阈值 180 秒与事件循环阻塞叠加：长时间同步任务（大仓库 git 操作）可能短暂误报；阈值取 6 个心跳周期，且巡检间隔 1 小时，实际只影响分钟级抖动
- 只读打开 WAL 库在极端情况下拿不到 shm：守护进程正常时 stateDir 可写，SQLite 会自行创建；失败按部件错误上报，不静默
- launchd 安装脚本会重装 `ai.pisa.opscheck`，与已有多个 worktree 共用时以最后一次安装为准（与现有 supervisor 行为一致）
