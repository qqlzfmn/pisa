# 018 · 实现计划

## 模块改动

| 文件 | 改动 |
| --- | --- |
| `src/web.ts` | 路由改为 `/state`、`/tickets*`、`/executor/pause`；API 拒绝 query token；错误体带 `reason`；新增 retry/stop/rewind/continue/logs；`/state` 带 `executor` |
| `src/status.ts` | 抽出 `BoardView` 与 `executorState`/`executorPaused`；`formatBoard` 直接渲染 View；`formatStatusBoard` 保持原签名与原输出 |
| `src/router.ts` | `fill()` 在 `meta.executor.paused=1` 时不再领取任务 |
| `src/cli.ts` | 重写为 HTTP 客户端：命令集覆盖 run/status/list/show/logs/retry/stop/merge/rewind/continue/wait/pause/resume/repos/help；退出码 0/1/2/3 |
| `src/web-ui.ts` | 改用新路径与 `ticket`/`ticketId`；不再给 API 请求拼 `?token=`（cookie 生效） |
| `tests/web.test.ts` | 覆盖新路由、暂停、retry、rewind、query token 拒绝 |
| `tests/cli.test.ts` | 起真实回环服务，覆盖四种退出码与越权 |
| `docs/operations.md`、`README.md`、`skills/pisa/` | 同步命令、接口与退出码 |

## 关键取舍

- **路径不带 `/api`**：验收固定了 `GET /state`、`/tickets/:id`，直接照用，旧 `/api/tasks*` 删除，不留别名。
- **retry 不新建 attempt 表**：有分支用 `continue`，无分支重投；原任务不可变，账本仍是一条任务一行。
- **暂停放 meta**：`executor.paused` 与心跳同一张 `meta` 表，重启天然保持；不新增表、不新增配置项。
- **CLI 只依赖 HTTP**：仓库校验、白名单、状态机都在 Router 里，CLI 不再复制一份；`repos` 例外，它读的是本地配置，离线也要能用。
- **退出码的边界**：`1` 专指「改动生效需要重启」，所以 `merge` 成功返回 1；任务失败、找不到、HTTP 错误都是 `2`；配置与鉴权是 `3`。

## 验证

- `bun test`：新增/更新用例覆盖 4 个退出码、401、query token 拒绝、暂停门控、retry 分支继承。
- `bunx tsc --noEmit`：类型检查。
- 手工：`bun run src/index.ts --web` 后用 `curl` 打 `/state`，再用 `pisa status --json` 对照。
