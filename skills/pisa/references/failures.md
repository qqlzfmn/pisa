# 失败模式与处理

先看退出码，再看任务状态与 `error`，最后看日志。不要在所有失败上重试同一个命令。

## 1. 退出码 1：需重启

- 含义：管理接口连不上（守护进程没起、`<stateDir>/api.json` 过期），或 `/state` 报心跳过期。
- 确认：`pisa status --json` 的 `daemon.alive`；直接看 `ls <stateDir>/api.json`。
- 处理：让人类启动 `bun run src/index.ts` 或对应 launchd 服务；启动后任务会自动被取走。不要重复提交。

提交时 stderr 出现"没有检测到运行中的 pisa 守护进程"是同一类信号：10 秒内没有心跳，任务已入队但不会被执行。

## 2. 任务一直是 queued

按顺序查：

```bash
pisa status --json                 # daemon.alive？executor.paused？running 是否达到 concurrency？
pisa show <id> --json              # status 是否仍为 queued
pisa repos --json                  # 仓库是否 allowed
```

- 守护进程在跑但 `running` 已满：排队是正常的，等。
- `executor.paused=true`：有人 `pisa pause` 了；让人类确认维护窗口结束后 `pisa resume`。
- `allowed=false`：`whitelist.repos` 没包含该别名，改配置后重新提交。
- 仓库路径不是 git 仓库：`pisa task` 会直接以 3 退出，不会入队。

## 3. 退出码 3：待配置

不是任务问题，原样重试不会成功：

- `未知仓库别名`：用 `pisa repos --json` 里的 alias。
- `不在 whitelist.repos`：让人类加白名单。
- `仓库路径不是 git 仓库`：检查 `repos[].path`。
- `找不到配置文件`：用 `--config` 指定，或从包含配置的目录调用。
- `管理接口未就绪` / 401 / 403：守护进程没起，或 `PISA_API_TOKEN` 与 `api.json` 里的 token 不一致。不要再用 query 参数传 token（管理接口只认请求头）。

## 4. 退出码 2：任务 failed

读 `pisa show <id> --json` 的 `error` 与 `pisa logs <id> --tail 200`。常见分类：

| error / 日志特征 | 原因 | 处理 |
| --- | --- | --- |
| `执行超时（Ns）` | Worker 超过 `worker.timeoutSec` | 拆小任务，或让人类调大超时 |
| `任务已取消` | 有人执行了 `stop` | 确认是否需要重提 |
| `提交失败` / `推送失败` | git 身份、权限、远程不可达 | 环境问题，修好后重提；不要改 brief 掩盖 |
| 编译/测试失败 | 代码没过验证 | 根据日志补 brief，`continue` 或新任务 |
| 空摘要 + 非零退出 | Worker 崩溃/认证失败 | 查日志末尾，必要时让人类检查 worker 命令 |

失败任务的分支与工作副本：失败时会删除工作副本；只有自建的 `pisa/<任务号>` 分支会被删，续跑共享的父分支保留。想快速重来用 `pisa retry <id> --json`：失败任务还有分支时在原分支上续跑，否则按原需求新开。

## 5. 退出码 7：wait 超时

任务可能仍在 running。处理顺序：

1. `pisa show <id> --json` 看当前状态
2. 仍 running：继续 `pisa wait <id> --timeout ...`，或先做别的事
3. paused：见第 6 条
4. 已终态：按对应退出码处理

不要因为超时就重复提交同一需求。

## 6. 退出码 6：不可运行

- `paused`：进程重启且工作副本与会话都在时进入。当前只能由人类在 pisa 会话里执行 `resume <任务号>`；CLI 不能恢复。
- `cancelled`：已停止。要重来用 `pisa retry <id>` 或新建任务。
- `rewound`：副作用已被撤销，不能继续。
- 对 succeeded / queued / running 的任务执行 `retry` 也会得到这个码：只有 failed / cancelled 能重试。

## 7. `continue` 报"没有可续跑的分支"

父任务没有 `branch`，通常是还在 queued/running，或失败后分支被清理。等父任务成功后重试；不要用 `continue` 猜分支名。

## 8. 重复提交返回原任务

`--event-id` 已存在时，CLI 返回原任务并带 `message: "事件已存在，返回原任务"`。这是幂等保护，不是错误。要建新任务，换一个 event id 或省略该参数。

## 9. 拿不到 PR 链接

- `delivery.push=false`：只提交到本地分支，不推送。
- `delivery.pr=false`：即使推送也不开 PR。
- 仓库没有 GitHub remote：只给 compare URL 或本地分支。
- `gh` 未安装或未登录：不开 PR。

这些是配置结果，不是失败。读 `show --json` 的 `branch` 与 `prUrl` 判断实际产物。

## 10. 数据库锁 / 读不到任务

`pisa.db` 由守护进程写，CLI 的 `task` / `continue` / `wait` / `list` 也直连同一个库（WAL）。正常并发不会锁死。若出现 `database is locked`：

- 确认没有脚本长时间持有事务
- 不要删除 `pisa.db`；先让人类停守护进程再排查
- 不要手工改库

## 11. 日志不存在

`pisa logs` 要求任务已开始执行并生成 `<stateDir>/logs/<任务号>.log`。queued 任务没有日志；用 `show` 看状态。
