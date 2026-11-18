# 失败模式与处理

先看退出码，再看任务状态与 `error`，最后看日志。不要在所有失败上重试同一个命令。

## 1. 退出码 1：控制面不可达

- 现象：`控制面不可达（127.0.0.1:<port>）：…`，或 `pisa status` 报心跳过期。
- 含义：守护进程没在跑、端口被别的进程占了，或配置里的 `web.port` 与守护进程不一致。
- 确认：`pisa status --json` 的 `daemon.alive` 与 `executor.paused`。
- 处理：让人类启动 `bun run src/index.ts` 或对应 launchd 服务；确认配置文件是同一份。不要重复提交——接口都没连上，任务根本没入队。

## 2. 任务一直是 queued

按顺序查：

```bash
pisa status --json                 # ok？executor.paused？running 数量是否达到 worker.concurrency？
pisa show <id> --json              # status 是否仍为 queued
pisa repos --json                  # 仓库是否 allowed
```

- `executor.paused=true`：有人执行了 `pisa executor pause`，`pisa executor resume` 恢复，或重启守护进程。
- 守护进程在跑但 `running` 已满：排队是正常的，等。
- `allowed=false`：`whitelist.repos` 没包含该别名，改配置后重新提交。
- 仓库路径不是 git 仓库：`pisa run` 直接以 3 退出，不会入队。

## 3. 退出码 3：配置、鉴权或用错

原样重试不会成功：

- `找不到配置文件`：用 `--config` 指定，或从包含配置的目录调用。
- `缺少环境变量 PISA_WEB_TOKEN`：设置 `web.tokenEnv` 指向的变量。
- `token 不匹配`：CLI、页面、脚本要用同一个 token；守护进程没配 tokenEnv 时打印的是一次性 token，不能复用。
- `未知仓库别名`：用 `pisa repos --json` 里的 alias。
- `不在 whitelist.repos`：让人类加白名单。
- `仓库路径不是 git 仓库`：检查 `repos[].path`。
- `未知选项` / 缺少正文 / `找不到任务`：修命令或任务号。

## 4. 退出码 2：任务 failed

读 `pisa show <id> --json` 的 `error` 与 `pisa logs <id> --tail 200`。常见分类：

| error / 日志特征 | 原因 | 处理 |
| --- | --- | --- |
| `执行超时（Ns）` | Worker 超过 `worker.timeoutSec` | 拆小任务，或让人类调大超时 |
| `任务已取消` | 有人执行了 cancel | 确认是否需要重提 |
| `提交失败` / `推送失败` | git 身份、权限、远程不可达 | 环境问题，修好后重提；不要改 brief 掩盖 |
| 编译/测试失败 | 代码没过验证 | 根据日志补 brief，`continue` 或新任务 |
| 空摘要 + 非零退出 | Worker 崩溃/认证失败 | 查日志末尾，必要时让人类检查 worker 命令 |

想把失败任务的需求原样重开：`pisa retry <id>`，会生成新任务；原任务有分支与 PR 时沿用同一分支与 PR。失败任务的工作副本会被删除；只有自建的 `pisa/<任务号>` 分支会被删，续跑共享的父分支保留。

## 5. 退出码 1：wait 超时

任务可能仍在 running。处理顺序：

1. `pisa show <id> --json` 看当前状态
2. 仍 running：`pisa wait <id> --timeout <更大值>`，或先做别的事
3. paused：`pisa resume <id>`（需要工作副本与会话都在），否则让人类处理
4. 已终态：按对应退出码处理

不要因为超时就重复提交同一需求。

## 6. 退出码 2：任务不可运行

动作被状态拒绝，通常是命令用错了状态：

- `paused`：`pisa resume <id>`；重启后无法恢复的会直接落 `failed`，用 `pisa retry <id>`。
- `cancelled`：需要就 `pisa retry <id>` 或新建任务。
- `succeeded`：不能 `cancel`；要撤销副作用用 `pisa rewind <id> --yes`。
- `rewound`：副作用已撤销，不能继续，重新提交。

## 7. `continue` 报"没有可续跑的分支"

父任务没有 `branch`，通常是还在 queued/running，或失败后分支被清理。等父任务成功后重试；不要用 `continue` 猜分支名。

## 8. 重复提交返回原任务

`--event-id` 已存在时，返回原任务号而不是新建。这是幂等保护，不是错误。要建新任务，换一个 event id 或省略该参数。

## 9. 拿不到 PR 链接

- `delivery.push=false`：只提交到本地分支，不推送。
- `delivery.pr=false`：即使推送也不开 PR。
- 仓库没有 GitHub remote：只给 compare URL 或本地分支。
- `gh` 未安装或未登录：不开 PR。

这些是配置结果，不是失败。读 `show --json` 的 `branch` 与 `prUrl` 判断实际产物。

## 10. 接口 5xx 或控制面起不来

- 守护进程日志里的 `控制面启动失败（127.0.0.1:<port>）`：端口被占用或没有权限。任务照常执行，但 CLI 与脚本全部连不上；换 `web.port` 或杀掉占用者后重启。
- 单个请求 500（`reason: "component"`）：通常是合并/撤销这类动作内部失败，读 `error` 原文，再看守护进程日志。
- 不要直接改 `pisa.db`；状态只由守护进程写入。

## 11. 日志不存在

`pisa logs` 要求任务已开始执行并生成 `<stateDir>/logs/<任务号>.log`。queued 任务没有日志；用 `show` 看状态。
