# 018 · 实施计划

## D1 检查集中在 `src/health.ts`，status 与 patrol 共用

`healthReport(cfg, store, deps?)` 返回 `{ exit, issues }`，`status` 与 `patrol` 只负责展示与投递。两处各写一份判断会让「退出码」和「巡检提醒」漂移（FR-001、FR-006）。

依赖注入只有两项：`token(envName)` 与 `now()`。前者让测试不碰真实 `~/.pisa`，后者让心跳过期不必真等 10 秒。

## D2 严重度取最大值，3 > 2 > 1

- 3 待配置：不改配置永远不会好，必须人先动手。
- 2 部件错误：外部动作已放弃重试，只有人能决定补发还是接受。
- 1 需重启：launchd + supervisor 大多能自愈；剩下的才是 supervisor 自身死亡或进程卡死。

配置错误排在最后是因为「配置不对」时其余结论都不可信（例如仓库路径错了，心跳正常也没有意义）。同一类内按 `key` 排序，保证输出与签名稳定（FR-002、FR-007）。

## D3 巡检是独立 CLI 命令，不挂在守护进程里

`pisa patrol` 由 launchd 每小时拉起一次。放进守护进程的定时器会在「进程活着但事件循环卡住」时一起失效，恰是 NFR-002 要防的场景。独立进程还能复用同一个 `pisa.db` 判断心跳与 outbox。

代价是数据库要能以两个进程同时打开：SQLite WAL 已满足，`Store` 本来就是多进程访问同一文件（CLI 一直如此）。

## D4 token 查找收敛到 `src/token.ts`，与 `scripts/tokens.sh` 同一约定

`status` 手动运行时环境里没有 launchd 注入的 token；只看 `process.env` 会把正常部署误判成待配置（NFR-004）。顺序与环境变量优先，与 supervisor 完全一致：

| 环境变量 | 回退文件 |
| --- | --- |
| `PISA_TELEGRAM_TOKEN` | `~/.pisa/telegram_token` |
| `PISA_WEBHOOK_TOKEN` | `~/.pisa/webhook_token` |
| `PISA_WEB_TOKEN` | `~/.pisa/web_token` |

脚本侧把三份重复的加载逻辑抽到 `scripts/tokens.sh`，由 `supervise.sh` 与 `patrol.sh` source，避免两份约定各自演进。

## D5 去重签名存 meta 表

键 `patrol:signature`，值为按 `issue.key` 排序后用 `|` 拼接。选 meta 而不是独立文件：随数据库一起存在 `stateDir`，进程无状态，测试也是同一个临时库。

- 健康 → `deleteMeta`：恢复清零（FR-007）
- 异常且签名相同 → 静默
- 签名不同 → 提醒后写入，问题集合变化自然触发再提醒

key 设计成「问题实例」而非「问题文本」：心跳只有 `daemon:down`，outbox 只有 `effects:failed`，仓库问题带别名。这样同一条问题数值变化（失败条数 1→2）不会重复打扰。

## D6 白名单只在存在远程入口时检查

`whitelist` 只影响聊天、Webhook、GitHub、Web、定时任务；纯 CLI 部署即使白名单为空也能派活。无条件检查会让这类部署永远得到 3（NFR-003）。判断条件：`telegram / webhook / github / web` 任一启用，或存在启用的定时任务。

## D7 launchd 两个 agent：守护 + 巡检

| agent | 拉起方式 | 日志 |
| --- | --- | --- |
| `ai.pisa.supervisor` | `KeepAlive`，进程退出即重启 | `~/Library/Logs/pisa.launchd.log` |
| `ai.pisa.patrol` | `StartInterval` 3600 + `RunAtLoad` | `~/Library/Logs/pisa.patrol.log` |

巡检不给 `KeepAlive`：它是有限时长的批处理，非零退出码是健康码而不是故障，`KeepAlive` 会导致反复拉起。安装脚本对两个 label 先 `bootout` 再 `bootstrap`，重复执行等于重装（FR-009）。

## D8 测试策略

- CLI 端到端（`tests/ops-status.test.ts`）：临时仓库 + 临时 `stateDir`，直接造心跳、过期心跳、失败 effect，断言四种退出码与优先级的对外表现。
- 巡检：连续调用 `pisa patrol`，断言首轮有输出、同问题输出为空、恢复后清零、问题变化再提醒。
- 单元级：`healthReport` 注入 `token`，覆盖 telegram 缺 token、定时任务缺身份、纯 CLI 白名单为空不误报。
- 不 mock 数据库与 git：检查本身就是读它们，mock 会把「真实误报」藏起来。

## D9 文档落点

- `docs/operations.md` 新增「健康与巡检」：退出码表、巡检行为、安装与日志、`patrol.chatId` 缺省规则。
- 既有「退出码」段落补一句 status/patrol 例外，避免读者按任务退出码理解。
- `skills/pisa/` 是 agent 的契约文档，必须同步：否则 agent 会把 `status` 的 1 当任务失败。
