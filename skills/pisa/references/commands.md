# 命令表

所有命令都是一次性进程：执行完即退出，不占终端。CLI 是本机管理接口的客户端，执行仍由守护进程负责。默认读 `PISA_CONFIG`，否则从当前目录向上找 `pisa.config.json`；也可用 `--config <path>`。

## 提交类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa run <需求>` | 新建 queued 任务 | `--repo <别名>`、`--event-id <幂等键>`、`--requester <名字>`、`--wait`、`--timeout <秒>`、`--interval <秒>`、`--json` |
| `pisa continue <任务号> <新要求>` | 在原分支上续跑 | 同上（`--repo` 被忽略，继承父任务仓库） |
| `pisa wait <任务号>` | 阻塞到终态 | `--timeout <秒>`（默认 1800）、`--interval <秒>`（默认 1）、`--json` |
| `pisa stop <任务号>` | 停止任务（排队立即取消，运行中登记取消） | `--json` |
| `pisa retry <任务号>` | 重试中断或失败的任务 | `--json` |

`run` / `continue` 的正文是位置参数，含空格时整体加引号。

## 查询类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa status` | 看板 + 守护进程心跳 + 执行器状态 | `--repo`、`--json` |
| `pisa list` | 任务列表 | `--repo`、`--status`、`--limit`（默认 20）、`--pr <编号>`、`--github-repo <owner/repo>`、`--json` |
| `pisa show <任务号>` | 单个任务详情 | `--json` |
| `pisa logs <任务号>` | 任务日志尾部 | `--tail <行数>`（默认 80）、`--json` |
| `pisa repos` | 配置的仓库 | `--json` |
| `pisa help` | 用法与退出码 | 无 |

`--status` 可选：`queued`、`running`、`paused`、`succeeded`、`failed`、`cancelled`、`rewound`。

## 维护类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa merge <任务号>` | 验证后合入主干 | `--force` 跳过并发检查、`--json` |
| `pisa rewind <任务号>` | 撤销副作用 | `--yes` 才执行，否则只预览、`--json` |

执行器暂停与恢复没有 CLI 子命令，直接调接口：`POST /executor/pause`、`POST /executor/resume`（请求头带 `x-pisa-token`），或点控制台表头的按钮。

## JSON 形状

`run` / `continue` / `wait`：

```json
{
  "id": "t_20261118_ab12cd",
  "status": "queued",
  "statusLabel": "排队",
  "stage": "working/queued",
  "stageLabel": "等空闲槽位",
  "repo": "demo",
  "branch": null,
  "prUrl": null,
  "baseRef": null,
  "prompt": "修 CI：...",
  "summary": null,
  "error": null,
  "duration": "0s",
  "createdAt": 1763424000000,
  "startedAt": null,
  "endedAt": null
}
```

`--wait --json` 只输出最终任务对象。`wait` 超时时输出当时的任务对象并以 2 退出，错误原因在 stderr。

`status --json`：

```json
{
  "ok": true,
  "daemon": { "alive": true, "ageMs": 412, "lastBeat": 1763424000000 },
  "executor": { "paused": false, "concurrency": 2, "active": 1 },
  "counts": { "queued": 1, "running": 1, "paused": 0, "succeeded": 3, "failed": 0, "cancelled": 0, "rewound": 0 },
  "total": 5,
  "repos": [{ "alias": "demo", "path": "/abs/demo", "remote": "git@...", "baseBranch": "main", "allowed": true }],
  "repo": null,
  "running": [Ticket],
  "queued": [Ticket],
  "finished": [Ticket]
}
```

接口不可达时 `status --json` 输出 `{"ok":false,"daemon":{"alive":false,...},"error":"..."}` 并以 1 退出。

`list --json` 是 `Ticket` 数组。`show --json` 是 `{"ok":true,"ticket":Ticket,"effects":[...],"logTail":[...]}`。`logs --json` 是 `{"ok":true,"ticketId":"...","path":"...","lines":[...]}`。`stop` / `retry` 输出 `{"ok":true,"ticket":Ticket,"message":"..."}`；`merge` 成功时额外带 `restartRequired: true`；`rewind` 带 `applied`。

## 退出码

| 码 | 语义 | 动作 |
| --- | --- | --- |
| 0 | 正常 | 读结果继续 |
| 1 | 需重启 | 接口不可达、心跳过期，或合并成功等待重启；先恢复守护进程 |
| 2 | 部件错误 | 4xx/5xx、任务失败、等待超时、用法错误；看 stderr 后再决定 |
| 3 | 待配置 | 配置文件缺失、未授权、仓库或用户不在白名单；改配置或换 `--requester` |

## 配置要点

- `repos[].alias` 是 `--repo` 的取值；不传时用第一个仓库。
- `whitelist.repos` 非空时，只有列出的别名可提交；`whitelist.users` 必须包含调用者（`--requester`、`PISA_CLI_USER` 或 `$USER`）。
- 相对 `stateDir` 与 `repos[].path` 以配置文件目录为基准。
- 接口地址默认 `http://127.0.0.1:<web.port>`，`PISA_API_URL` 可覆盖但只接受回环地址。
- token 取 `${web.tokenEnv}`；没有时读 `<stateDir>/api.token`（由守护进程生成，0600）。
- 日志在 `<stateDir>/logs/<任务号>.log`。
