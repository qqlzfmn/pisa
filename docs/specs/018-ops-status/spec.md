# 018 · 运行健康与每小时巡检

- 状态：implemented
- 关联：README「用法」的 `/status`；010（任务看板）、017（阶段投影）
- 依赖：无

## 1. 问题

- 判断 pisa 是否健康只能人读日志。`pisa status` 永远返回 0，输出里只有「守护进程：运行中/未运行」一行；脚本没法按状态分支，人也要读完看板才知道该不该动手。
- 守护进程死了没人知道。`scripts/supervise.sh` 只在进程退出时重启；事件循环阻塞、卡在长任务里这类「进程活着但不干活」不会触发重启。
- 没有「异常才说话」的通道。想加例行检查，要么每次都说（刷屏），要么只在第一次说（恢复后不再提醒）；去重状态没有落库的地方。

## 2. 目标

- 机器可判：`pisa status` 的退出码就是健康结论，不看输出也能分支。
- 人可判：异常时人类输出逐条列出问题；正常时不多说一个字。
- 半夜可发现：每小时自动检查一次，异常发到 Telegram；正常与重复问题静默。
- 可恢复：问题消失后提醒状态清零，同类问题再次出现会重新提醒。

## 3. 用户故事

### US-1 脚本按退出码分流

作为写监控脚本或 CI 步骤的人，我不用解析文本就能知道 pisa 是该重启、该修配置，还是该处理失败的外部动作。

- Given 配置完整、仓库路径有效、守护进程心跳新鲜，When 执行 `pisa status`，Then 退出码 `0`。
- Given 守护进程从未上报心跳，或最后心跳超过 10 秒，When 执行 `pisa status`，Then 退出码 `1`。
- Given 存在重试已耗尽的 push / PR / 评论动作，When 执行 `pisa status`，Then 退出码 `2`。
- Given 配置里没有仓库、没有入口、启用通道却取不到 token，或仓库路径不是 git 仓库，When 执行 `pisa status`，Then 退出码 `3`。
- Given 同时存在多类问题，When 执行 `pisa status`，Then 退出码取最严重的一类（3 > 2 > 1），输出按严重度列出全部问题。

### US-2 巡检只在需要人时说话

作为把 pisa 常驻在自己机器上的人，我希望半夜挂了会被叫醒，白天正常工作或同一个已知问题时不要反复打扰。

- Given 一切正常，When 每小时巡检，Then 不产生任何输出、不发任何消息，退出码 `0`。
- Given 出现新问题，When 巡检，Then 输出问题清单；配置了会话语义时同时发一条 Telegram，退出码与健康码一致。
- Given 同一组问题仍然存在，When 下一次巡检，Then 静默，不再发消息。
- Given 问题消失，When 巡检，Then 静默且退出码 `0`；之后同一个问题再次出现时重新提醒。
- Given 问题集合变化（新增一条或换成另一条），When 巡检，Then 重新提醒一次完整清单。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `pisa status` 返回 0 正常 / 1 需重启 / 2 部件错误 / 3 待配置 |
| FR-002 | 多个问题同时存在时退出码取最严重的一项，顺序为 3 > 2 > 1；人类输出列出全部问题 |
| FR-003 | 「待配置」覆盖：repos 为空；启用的远程入口（telegram / webhook / github / web / 定时任务）下 `whitelist.users` 为空、`whitelist.repos` 为空或指向不存在的别名；没有任何入口；启用 telegram / webhook 却取不到 token；启用 github 却没有完整仓库条目；有待执行定时任务却缺 `scheduler.chatId`/`userId`；仓库路径不是 git 仓库 |
| FR-004 | 「部件错误」= outbox 中状态为 `failed`（重试耗尽）的动作存在 |
| FR-005 | 「需重启」= 守护进程无心跳，或最后心跳距今超过 10 秒 |
| FR-006 | 每小时巡检命令正常时零输出、零消息 |
| FR-007 | 巡检按问题标识集合去重：同一集合只提醒一次；恢复健康时清零；集合变化时重新提醒 |
| FR-008 | 巡检提醒在 telegram 启用且有会话时发出（`patrol.chatId`，缺省沿用 webhook → github → scheduler 的 `chatId`）；发送失败只写 stderr，问题仍由 `status` 暴露 |
| FR-009 | 提供 launchd 每小时任务与日志文件，重复安装幂等 |
| FR-010 | 文档写明 status/patrol 的退出码例外、巡检行为与安装方式；技能文档同步说明 |

| ID | 非功能需求 |
| --- | --- |
| NFR-001 | 健康检查只读：不修改任务状态，只允许写巡检签名这一条 meta |
| NFR-002 | 巡检独立于守护进程运行：守护进程卡死时巡检仍能发现问题 |
| NFR-003 | 纯 CLI 部署不因白名单为空误报「待配置」 |
| NFR-004 | token 查找与 `scripts/tokens.sh` 同一约定（环境变量 → `~/.pisa/<约定名>`），手动运行与 launchd 运行结论一致 |

## 5. 验收

1. `tests/ops-status.test.ts` 覆盖 status 四种退出码与严重度合并
2. 同一文件覆盖巡检：首轮提醒、同问题静默、恢复清零、问题变化再提醒
3. `status --json` 的 `health` 字段含 `exit`、`label`、`issues[]`（每项有稳定 `key`）
4. `scripts/install-launchd.sh` 安装 `ai.pisa.patrol`（`StartInterval` 3600，日志 `~/Library/Logs/pisa.patrol.log`）
5. 纯 CLI 配置且心跳新鲜时退出码为 0
6. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- **自动修复**：只报告，不替人重启、不代重试失败动作。
- **外部依赖监控**：磁盘、代理、git 远程、Telegram API 可用性都不在四项码内。
- **更多通知渠道**：只复用已启用的 Telegram，不新增邮件、Webhook 告警。
- **Web 控制台展示健康码**：留给后续 feature。
