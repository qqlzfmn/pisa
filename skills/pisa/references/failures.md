# 失败模式与处理

先看退出码，再看任务状态与 `error`，最后看日志。不要在所有失败上重试同一个命令。CLI 已经不连库：任何「读不到状态」先判断是不是 API 不可达。

## 1. 退出码 2：连不上管理 API

`stderr` 形如「无法连接管理 API（http://127.0.0.1:8787）：…」。

- 确认守护进程在跑；`pisa status --json` 同样会以 2 退出，不会入队。
- 确认配置里 `web.enabled: true`，端口与 `web.port` 一致；临时可用 `--url` 指定地址。
- 启动守护进程后重试；不要重复提交任务。

## 2. 退出码 3：待配置

原样重试不会成功：

- 缺 token：导出 `web.tokenEnv` 指定的变量（默认 `PISA_WEB_TOKEN`），值需与守护进程一致。
- token 不匹配：API 返回 401，检查环境变量是否指向另一份配置的 token。
- `未知仓库别名`：用 `pisa repos --json` 里的 alias。
- `不在 whitelist.repos`：让人类加白名单。
- `仓库路径不是 git 仓库`：检查 `repos[].path`。
- `找不到配置文件`：用 `--config` 指定，或从包含配置的目录调用。

## 3. 任务一直是 queued

按顺序查：

```bash
pisa status --json                 # daemon.alive、executor.paused、running 是否达到 concurrency
pisa show <id> --json              # status 是否仍为 queued
pisa repos --json                  # 仓库是否 allowed
```

- `executor.paused=true`：有人执行了 `pisa pause`；让人类确认后 `pisa resume`。
- 守护进程在跑但 `running` 已满：排队是正常的，等。
- `allowed=false`：`whitelist.repos` 没包含该别名，改配置后重新提交。

## 4. 退出码 2：任务 failed

读 `pisa show <id> --json` 的 `error` 与 `pisa logs <id> --tail 200`。常见分类：

| error / 日志特征 | 原因 | 处理 |
| --- | --- | --- |
| `执行超时（Ns）` | Worker 超过 `worker.timeoutSec` | 拆小任务，或让人类调大超时 |
| `任务已取消` | 有人执行了 `stop` | 确认是否需要 `retry` |
| `提交失败` / `推送失败` | git 身份、权限、远程不可达 | 环境问题，修好后 `retry`；不要改 brief 掩盖 |
| 编译/测试失败 | 代码没过验证 | 根据日志补 brief，`retry`、`continue` 或新任务 |
| 空摘要 + 非零退出 | Worker 崩溃/认证失败 | 查日志末尾，必要时让人类检查 worker 命令 |

失败任务的工作副本会删除；自建的 `pisa/<任务号>` 分支也会删。`retry` 对没有分支的任务按原需求新开一单，对有共享父分支的任务在原分支上续跑。不要依赖失败任务的分支继续改。

## 5. 退出码 2：wait 超时

`--json` 输出 `{id,status,timeout:true}`。任务可能仍在 running。处理顺序：

1. `pisa show <id> --json` 看当前状态
2. 仍 running：继续 `pisa wait <id> --timeout ...`，或先做别的事
3. paused：见第 6 条
4. 已终态：按对应退出码处理

不要因为超时就重复提交同一需求。

## 6. 退出码 2：找不到任务或状态冲突

- `找不到任务`：检查任务号；不要假设任务存在。
- 状态冲突（HTTP 409）：对终态任务 `stop`、对非失败任务 `retry`、对非成功任务 `merge` 都会被拒。先 `pisa show` 看 `status`。

## 7. paused 任务

- `paused`：进程重启且工作副本与会话都在时进入。在 pisa 会话里执行 `resume <任务号>`；CLI 的 `pisa resume` 只恢复执行器闸门，不恢复单个任务。
- 正在等待的 `pisa wait` 遇到 paused 会以 2 退出并输出当前任务对象。

## 8. `continue` 报"没有可续跑的分支"

父任务没有 `branch`，通常是还在 queued/running，或失败后分支被清理。等父任务成功后重试；不要用 `continue` 猜分支名。

## 9. 重复提交返回原任务

`--event-id` 已存在时返回原任务，`message` 说明是重复投递或需求更新。这是幂等保护，不是错误。要建新任务，换一个 event id 或省略该参数。

## 10. 拿不到 PR 链接

- `delivery.push=false`：只提交到本地分支，不推送。
- `delivery.pr=false`：即使推送也不开 PR。
- 仓库没有 GitHub remote：只给 compare URL 或本地分支。
- `gh` 未安装或未登录：不开 PR。

这些是配置结果，不是失败。读 `show --json` 的 `branch` 与 `prUrl` 判断实际产物。

## 11. 日志不存在

`pisa logs` 要求任务已开始执行并生成 `<stateDir>/logs/<任务号>.log`。queued 任务没有日志；用 `show` 看状态。

## 12. 直接查库排查

CLI 不再读库。需要绕过 API 看数据时，只读打开：

```bash
sqlite3 -readonly <stateDir>/pisa.db 'select id,status,error from tasks order by created_at desc limit 10'
```

不要删除 `pisa.db`；先让人类停守护进程再排查；不要手工改库。
