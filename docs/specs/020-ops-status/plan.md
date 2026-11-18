# 020 · 实施计划

## D1 判定层独立成 `src/health.ts`

目前健康事实分散在三处：心跳（`status.daemonState`）、熔断记录（无）、配置（`config.ts` 只解析不校验）。把它们拼成退出码的逻辑如果放进 `cli.ts`，巡检就得复制一份，两处口径迟早分叉。

所以新增 `health.ts`，只依赖 `config` / `store` 的类型、`git.isGitRepo`、`scheduler.parseCron` 与 `status.daemonState`：

- `configProblems(cfg, env)`：纯函数，不读盘之外的状态（`isGitRepo` 会跑一次 `git rev-parse`）
- `checkOps(cfg, store, now)`：唯一出口，CLI 与巡检都调它
- `ComponentHealth` / `OpsWatch`：写侧（部件记账、小时巡检）

`status.ts` 保持「看板投影」职责，不掺运维判定；健康判定反过来复用 `daemonState`，心跳阈值只有一处。

## D2 `daemonState` 参数放宽为结构类型

`daemonState(store: Store)` 只用到 `lastBeat()`。改成 `{ lastBeat(): number | null }` 后，`health.ts` 不需要依赖完整 `Store`，测试也不必造库。没有行为变化。

## D3 部件错误落 `meta`，不建表

三张表都不适合：`events` 是去重账本、`effects` 是副作用重试、`tasks` 是任务。部件错误是「单值 + 前缀查询」，`meta` 已经是心跳与轮询游标的家，加一个前缀即可。

键格式 `health:<部件>`，值 `{"message","at"}`；读取用 `metaByPrefix("health:")`（新增方法），清除用 `deleteMeta`（新增方法）。同一部件的同一条消息不重写，避免每小时一次写事务。

期限：不设 TTL。部件恢复才清零正是需求，用时间过期会让「一直坏着」的系统突然变绿。

## D4 退出码优先级：配置 > 重启 > 部件

- 配置错误时重启无意义：进程会以同样原因再挂一次；
- 进程没在跑时，上次运行留下的部件错误不是当前动作；
- 部件错误只在进程活着时才有修复路径。

报告仍列全部问题，退出码只回答「先做哪件事」，脚本据此分支。

## D5 巡检复用 Router 的消息流

`OpsWatch` 只做「判定 + 去重 + 投一条 `IncomingMessage`」，不直接调用通道、不自己拼提示词以外的格式。这样修复动作走正常的任务链路（排队、工作副本、回执、账本），和其它入口一致。

去重沿用 `Proactive` 探针的做法：签名落库、签名相同即静默。区别是探针按冷却窗口重发，巡检只在签名变化时说话——「同一问题去重，恢复后清零」。

巡检不检查「需重启」：巡检跑在守护进程里，进程死了巡检也死了。那一档只由 `pisa status` 对外表达。

## D6 配置缺项与巡检自锁

`ops` 配置缺 `chatId` / `userId` 时巡检不启动，同时 `configProblems` 报 `ops` 缺收件人。避免「巡检启动了但发不出去」的哑状态。

## D7 部件接线的取舍

只接三处「现在只打日志、出问题时人看不出来」的部件：

- `GithubWatcher`：轮询失败只 `console.warn`，token 过期时会一直静默失败
- `gc`：残留清理失败只 `console.error`
- 触发层启动：失败只 `console.error`，服务实际没起来

Telegram 菜单注册失败不影响收发消息，不接。
