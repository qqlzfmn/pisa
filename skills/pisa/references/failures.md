# 失败模式与处理

先看退出码：`3` 是环境没准备好，`2` 是命令或任务没成功，`1` 是等你去重启。再看任务状态与 `error`，最后看日志。不要在所有失败上重试同一个命令。

## 1. 退出码 3：待配置

CLI 走本机管理接口，这一类错误说明接口还用不了：

| stderr 片段 | 含义 | 处理 |
| --- | --- | --- |
| `读不到配置` | 找不到配置文件 | 用 `--config` 指定，或从放配置的目录调用 |
| `管理接口未启用` | `web.enabled` 不是 `true` | 让人类改配置并重启守护进程 |
| `找不到管理 token` | 环境变量与 `<stateDir>/mgmt.token` 都没有 | 让人类启动守护进程；token 由它写入 |
| `未授权` | token 不匹配 | 检查 `${web.tokenEnv}` 是否与守护进程一致 |
| `仓库未配置` / `无权限` / `不在 whitelist` | 仓库没配或没在白名单 | 换 `pisa status --json` 里的 alias，或让人类加白名单 |

## 2. 退出码 2 且提示「连不上管理接口」

守护进程没在跑，或端口不是配置里的 `web.port`。让人类启动 `bun run src/index.ts` 或对应 launchd 服务，再重试。不要重复提交。

## 3. 任务一直是 queued

按顺序查：

```bash
pisa status --json                 # daemon.alive？executor.paused？running 是否达到 concurrency？
pisa show <id> --json              # status 是否仍为 queued
```

- `executor.paused=true`：有人在 `pisa pause` 之后没恢复，用 `pisa pause --resume`。
- 守护进程在跑但 `running` 已满：排队是正常的，等。
- 仓库路径不是 git 仓库：提交时会直接以 `2` 退出，不会入队。

## 4. 退出码 2：用法或任务失败

**用法类**：`未知选项`、缺少正文、`未知状态`、`找不到任务`、`需要 confirm`。修命令，原样重试不会成功。

**任务未成功**：`wait` 结束时任务为 `failed` / `cancelled` / `rewound` 也是 `2`。读 `pisa show <id> --json` 的 `error` 与 `pisa logs <id> --tail 200`：

| error / 日志特征 | 原因 | 处理 |
| --- | --- | --- |
| `执行超时（Ns）` | Worker 超过 `worker.timeoutSec` | 拆小任务，或让人类调大超时 |
| `任务已取消` | 有人执行了 `pisa stop` | 确认是否需要重提 |
| `提交失败` / `推送失败` | git 身份、权限、远程不可达 | 环境问题，修好后用 `pisa retry` |
| 编译/测试失败 | 代码没过验证 | 根据日志补 brief，`continue` 或新任务 |
| 空摘要 + 非零退出 | Worker 崩溃/认证失败 | 查日志末尾，必要时让人类检查 worker 命令 |

失败任务的分支与工作副本：失败时会删除工作副本；只有自建的 `pisa/<任务号>` 分支会被删，续跑共享的父分支保留。要接着改，先确认父任务 `branch` 非空。

## 5. 退出码 2 且 stderr 写着「等待超时」

任务可能仍在 running。处理顺序：

1. `pisa show <id> --json` 看当前状态
2. 仍 running：继续 `pisa wait <id> --timeout ...`，或先做别的事
3. paused：见第 6 条
4. 已终态：按对应退出码处理

不要因为超时就重复提交同一需求。

## 6. 任务停在 paused / cancelled / rewound

- `paused`：进程重启且工作副本与会话都在时进入。当前只能由人类在 pisa 会话里执行 `resume <任务号>`；CLI 不能恢复。
- `cancelled`：已取消，需要就 `pisa retry` 或新建任务。
- `rewound`：副作用已被撤销，不能继续。

## 7. `continue` 报"没有可续跑的分支"

父任务没有 `branch`，通常是还在 queued/running，或失败后分支被清理。等父任务成功后重试；不要用 `continue` 猜分支名。

## 8. 重复提交返回原任务

`--event-id` 已存在时返回原任务并带提示。这是幂等保护，不是错误。要建新任务，换一个 event id 或省略该参数。

## 9. 退出码 1：合并后需要重启

`pisa merge <任务号> --confirm` 在非看护模式下把改动合入主干，但当前进程还跑着旧代码，退出码为 `1`。不要自己重启：交给看护进程或人。脚本可以按 `1` 决定「稍后重启并继续」。

## 10. 拿不到 PR 链接

- `delivery.push=false`：只提交到本地分支，不推送。
- `delivery.pr=false`：即使推送也不开 PR。
- 仓库没有 GitHub remote：只给 compare URL 或本地分支。
- `gh` 未安装或未登录：不开 PR。

这些是配置结果，不是失败。读 `show --json` 的 `branch` 与 `prUrl` 判断实际产物。

## 11. 日志不存在

`pisa logs` 要求任务已开始执行并生成 `<stateDir>/logs/<任务号>.log`。queued 任务没有日志；用 `show` 看状态。
