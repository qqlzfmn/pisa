# 020 · 状态退出码与小时巡检

- 状态：implemented
- 关联：010-status-board（看板）、018-health-metrics（`/health` 与心跳口径）、008-repo-routing（仓库配置）、019-trigger-adapters（触发层）

## 1. 问题

看状态只能人读：`/pisa status` 是文本，`pisa status` 无论系统是否健康都退 0（`src/cli.ts` 的 `case "status"` 直接 `return EXIT.ok`）。后果有三条：

- 脚本与 agent 无法用退出码判断「要不要重启」「要不要改配置」，只能抓文本；
- 半夜守护进程挂掉、GitHub 轮询一直失败、token 过期，没有任何主动出口，天亮才被发现；
- 手动盯着看板又会产生噪音：同一件事重复提醒，修好后也不清零。

能反映健康的事实已经散落在库里：心跳（`meta.heartbeat`，`daemonState()` 判定 10 秒过期）、任务终态、配置。缺的是「把事实归成一个动作」的判定层，以及按小时运行的巡检。

## 2. 目标

- `pisa status` 用四种退出码表达结论：0 正常 / 1 需重启 / 2 部件错误 / 3 待配置
- 同一份判定同时给出人读的问题列表，异常才输出
- 守护进程里每小时巡检一次；只有「问题签名变化」才开单（交给 Router 当修复任务），正常时完全静默
- 恢复后清零：问题消失即删除状态，下次再出现会重新提醒
- 判定、记录、巡检集中在一个模块，看板与 `/health` 不动

## 3. 口径

### 3.1 四种状态

| 退出码 | 名称 | 判定依据 | 运维动作 |
| --- | --- | --- | --- |
| 0 | 正常 | 无配置问题、心跳新鲜、无部件错误 | 不用管 |
| 1 | 需重启 | 心跳缺失或超过 `HEARTBEAT_STALE_MS`（10 秒） | 拉起守护进程 |
| 2 | 部件错误 | 守护进程在跑，但有部件留下了未清的错误记录 | 看问题列表修 |
| 3 | 待配置 | 配置文件或环境变量缺必需项 | 改配置或补环境变量 |

优先级：`待配置` > `需重启` > `部件错误` > `正常`。理由：配置缺东西时重启只会再挂一次；守护进程没运行时，上一次运行留下的部件错误已经过期，先让进程起来才是当前动作。报告里仍然列出全部问题，退出码只表达「先做哪件事」。

### 3.2 待配置的检查项

全部是「配置声明了、但前提不成立」的事实，不猜测意图：

| 来源 | 判定 |
| --- | --- |
| `repos` | 为空 → 没有可派活的仓库 |
| `repos[].path` | `isGitRepo()` 为假 → 路径不是 git 仓库 |
| `channels.telegram` | 启用但环境变量 `tokenEnv` 缺失 |
| `webhook` | 启用但环境变量 `tokenEnv` 缺失 |
| `web.userId` | 控制台启用但该用户不在 `whitelist.users`，页面派活会被拒 |
| `triggers` | 启用的入口缺密钥环境变量（GitHub Actions / 飞书 / 企业微信）；`fileWatch` 缺 `chatId` / `userId` |
| `github` | 启用但拿不到 token（`tokenEnv` 指向的变量或 `GH_TOKEN` 都为空） |
| `scheduler` | 有启用的 `schedules` 但 `scheduler.chatId` / `userId` 缺失 |
| `schedules[].cron` | `parseCron()` 解析失败，该 job 会被跳过 |
| `whitelist.users` | 为空且有任一远程入口启用（telegram / webhook / web / triggers），请求会被一律拒绝 |
| `ops` | 启用但 `chatId` / `userId` 缺失，提醒发不出去 |

`whitelist.users` 为空不单独算错误：只跑 CLI 的机器不需要白名单。

### 3.3 部件错误

部件在运行期出错时写 `meta` 的 `health:<部件>`，值为 `{"message": string, "at": number}`；该部件恢复后删除这条记录。判定只读记录，不重新探测：

| 部件 | 写入时机 | 清除时机 |
| --- | --- | --- |
| `github` | 评论拉取失败、评论类型判定失败、单仓库投递异常 | 一轮轮询全部成功 |
| `triggers` | 触发适配层启动抛错 | 启动成功 |
| `gc` | 定期残留清理失败 | 清理成功 |

同一个部件的同一条消息不重复写库，避免每小时巡检都产生写事务。记录没有过期时间：不清除就一直是事实，符合「恢复后清零」。

记录只描述当前进程：守护进程启动时先清空 `health:` 前缀（`ComponentHealth.reset()`），上一轮运行的失败不会带进新进程；部件再次失败会重新记账。

### 3.4 巡检

- 间隔固定 1 小时（`OPS_CHECK_INTERVAL_MS`），启动时立刻跑一次，之后每小时
- 关闭条件：`ops.enabled` 不为真，或缺 `chatId` / `userId` → 不启动（缺项由 `pisa status` 报 3）
- 问题签名 = `退出码` + 按来源排序的问题列表；签名与库里 `meta.ops:alert` 一致时静默
- 签名变化就开单：`eventId` 用当前时刻，消息正文是问题列表 + 处置提示；`prompt` 可由 `ops.prompt` 覆盖
- 退出码为 0 时删除 `meta.ops:alert`，下一次异常重新提醒
- 巡检本身不写心跳，不影响 `daemonState`

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `src/health.ts`：`OPS_EXIT`（`ok:0` / `restart:1` / `component:2` / `config:3`）、`configProblems(cfg, env)`、`checkOps(cfg, store, now)`、`formatOpsProblems(report)`、`ComponentHealth`、`OpsWatch` |
| FR-002 | `configProblems` 覆盖 3.2 的检查项，`detail` 只含静态事实（不带时间戳），保证签名稳定 |
| FR-003 | `checkOps(cfg, store, env = process.env, now = Date.now())` 返回 `{ exitCode, problems }`；`problems` 每项带 `level`（`config` / `restart` / `component`）、`source`、`detail`，退出码按 3.1 的优先级计算 |
| FR-004 | `ComponentHealth.fail(component, err)` 写 `meta.health:<component>`（消息截断到 300 字，同消息不重写），`ok(component)` 删除记录，`reset()` 清空全部记录（守护进程启动时调用） |
| FR-005 | `pisa status` 返回 `checkOps` 的退出码；人类输出在健康时不新增任何行，异常时逐行输出 `<级别>：<来源> <详情>` |
| FR-006 | `pisa status --json` 增加 `ops` 字段：`{ exitCode, problems }` |
| FR-007 | `OpsWatch.start()` 立即巡检一次并按 `OPS_CHECK_INTERVAL_MS` 循环，`stop()` 收掉定时器；`tick()` 可直接调用以便测试 |
| FR-008 | `ops` 配置：`{ enabled, chatId?, userId?, prompt?, repo?, intervalSec? }`；`intervalSec` 缺省 3600，小于 60 按 60 处理 |
| FR-009 | 部件错误接线：`GithubWatcher`（`github`）、`index.ts` 的 `gc`（`gc`）与触发层启动（`triggers`） |
| FR-010 | 巡检开单走同一条消息流：`channel: "proactive"`、`isDirect: true`、`eventId: "ops:<签名指纹>:<时刻>"`，`text` 由 `formatOpsProblems` 生成 |
| FR-011 | `daemonState` 的参数放宽为 `{ lastBeat(): number | null }`，健康判定直接复用它，不另写心跳规则 |
| FR-012 | `Store` 增加 `deleteMeta(key)` 与 `metaByPrefix(prefix)` |

## 5. 验收

1. 心跳新鲜、配置完整、无部件记录 → `pisa status` 退 0
2. 心跳过期 → 退 1，输出含「需重启」
3. 心跳新鲜 + `meta.health:github` 有记录 → 退 2，输出含该部件消息
4. 仓库路径不是 git 仓库 / telegram 缺 token → 退 3；同时心跳过期时仍是 3
5. 巡检：同一签名连续两轮只开一单；`checkOps` 恢复为 0 后状态清零，再出问题重新开单
6. `ComponentHealth`：同消息重复 `fail` 不更新时间戳，`ok` 删除记录
7. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 不改 `/health` 的 `ok` 语义（仍然只取心跳），不给 Web 页面加健康面板
- 不做外部监控推送、不做多收件人、不做告警升级
- 不自动重启进程、不自动改配置：巡检只开单，由 Router 执行修复
- 不给其它退出码改名，`0–5` 在 `task` / `wait` 等命令上的语义保持不变
