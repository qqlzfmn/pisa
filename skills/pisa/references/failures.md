# 失败模式与处理

先看退出码，再看任务状态与 `error`，最后看日志。不要在所有失败上重试同一个命令。

## 1. 提交时退出码 1，stderr 提示心跳已过期

- 含义：10 秒内没有心跳，任务已入队但不会被执行。
- 确认：`pisa status --json` 的 `daemon.alive`。
- 处理：让人类启动 `bun run src/index.ts` 或对应 launchd 服务；启动后任务会自动被取走。不要重复提交。

接口完全不可达时同样是 1，stderr 会写「守护进程可能没启动」。

## 2. 任务一直是 queued

按顺序查：

```bash
pisa status --json                 # daemon.alive？running 数量是否达到 worker.concurrency？
pisa show <id> --json              # status 是否仍为 queued
pisa repos --json                  # 仓库是否 allowed
```

- 守护进程在跑但 `running` 已满：排队是正常的，等。
- `allowed=false`：`whitelist.repos` 没包含该别名，改配置后重新提交。
- 仓库路径不是 git 仓库：`pisa run` 以 3 退出，不会入队。

## 3. 退出码 3：待配置

配置或鉴权问题，原样重试不会成功：

- `未知仓库别名`：用 `pisa repos --json` 里的 alias。
- `不在 whitelist.repos` 或用户不在 `whitelist.users`：让人类加白名单，或用 `--requester` 换成已授权身份。
- `仓库路径不是 git 仓库`：检查 `repos[].path`。
- `找不到配置文件`：用 `--config` 指定，或从包含配置的目录调用。
- `未授权`：`${web.tokenEnv}` 与 `<stateDir>/api.token` 里的 token 对不上，交给人核对。

## 3b. 退出码 2：用法或部件错误

- `未知选项` / 缺少正文：修命令。
- 4xx/5xx：看 stderr 里的接口错误原文；404 说明任务号不存在，409 说明当前状态不允许这个动作。
- `pisa list --status` 传了未知状态：按命令表里的七个值改。

## 4. 任务 failed（`wait` 以 2 退出）

读 `pisa show <id> --json` 的 `error` 与 `pisa logs <id> --tail 200`。常见分类：

| error / 日志特征 | 原因 | 处理 |
| --- | --- | --- |
| `执行超时（Ns）` | Worker 超过 `worker.timeoutSec` | 拆小任务，或让人类调大超时 |
| `任务已取消` | 有人执行了 cancel | 确认是否需要重提 |
| `提交失败` / `推送失败` | git 身份、权限、远程不可达 | 环境问题，修好后重提；不要改 brief 掩盖 |
| 编译/测试失败 | 代码没过验证 | 根据日志补 brief，`continue` 或新任务 |
| 空摘要 + 非零退出 | Worker 崩溃/认证失败 | 查日志末尾，必要时让人类检查 worker 命令 |

失败任务的分支与工作副本：失败时会删除工作副本；只有自建的 `pisa/<任务号>` 分支会被删，续跑共享的父分支保留。不要依赖失败任务的分支继续改。要续跑，先确认父任务 `branch` 非空。

## 5. wait 超时（退出码 2，stderr 有「等待超时」）

任务可能仍在 running。处理顺序：

1. `pisa show <id> --json` 看当前状态
2. 仍 running：继续 `pisa wait <id> --timeout ...`，或先做别的事
3. paused：见第 6 条
4. 已终态：按对应退出码处理

不要因为超时就重复提交同一需求。

## 6. 任务不可运行（paused / cancelled / rewound）

- `paused`：进程重启且工作副本与会话都在时进入。用 `pisa retry <id>` 恢复；工作副本丢了就重建任务。
- `cancelled`：已取消，需要就新建任务。
- `rewound`：副作用已被撤销，不能继续。

## 7. `continue` 报"没有可续跑的分支"

父任务没有 `branch`，通常是还在 queued/running，或失败后分支被清理。等父任务成功后重试；不要用 `continue` 猜分支名。

## 8. 重复提交返回原任务

`--event-id` 已存在时，CLI 返回原任务并以 0 退出，`message` 会是「任务 … 已存在」或「还没开跑，已按最新版本更新需求」。这是幂等保护，不是错误。要建新任务，换一个 event id 或省略该参数。

## 9. 拿不到 PR 链接

- `delivery.push=false`：只提交到本地分支，不推送。
- `delivery.pr=false`：即使推送也不开 PR。
- 仓库没有 GitHub remote：只给 compare URL 或本地分支。
- `gh` 未安装或未登录：不开 PR。

这些是配置结果，不是失败。读 `show --json` 的 `branch` 与 `prUrl` 判断实际产物。

## 10. 接口报 500 或读不到任务

CLI 不直接读数据库；状态由守护进程返回。先 `pisa status --json` 确认进程健康，再看 `<stateDir>/logs` 与守护进程 stderr。不要删除 `pisa.db`，也不要手工改库。

## 11. 日志不存在

`pisa logs` 要求任务已开始执行并生成 `<stateDir>/logs/<任务号>.log`。queued 任务没有日志；用 `show` 看状态。任务号不存在时接口返回 404，CLI 以 2 退出。
