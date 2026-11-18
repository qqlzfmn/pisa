# 命令表

所有命令都是一次性进程：执行完即退出，不占终端。CLI 是守护进程本地管理 API 的客户端，只发 HTTP 到 `127.0.0.1`，不读 `pisa.db`。

前置条件：守护进程在跑，配置里 `web.enabled: true`，且 `web.tokenEnv`（默认 `PISA_WEB_TOKEN`）指向的 token 与守护进程一致。默认读 `PISA_CONFIG`，否则从当前目录向上找 `pisa.config.json`；也可用 `--config <path>`。`--url <base>` 覆盖 API 地址，默认 `http://127.0.0.1:<web.port>`。

## 提交类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa run <需求>`（`task` 同义） | 新建 queued 任务 | `--repo <别名>`、`--event-id <幂等键>`、`--wait`、`--timeout <秒>`、`--interval <毫秒>`、`--json` |
| `pisa continue <任务号> <新要求>` | 在原分支上续跑 | `--event-id <幂等键>`、`--wait`、`--json`（`--repo` 被忽略，继承父任务仓库） |
| `pisa retry <任务号>` | 失败/取消后重跑：有分支则续跑原分支，无分支按原需求新开一单；原任务不变 | `--wait`、`--json` |
| `pisa wait <任务号>` | 阻塞到终态 | `--timeout <秒>`（默认 1800）、`--interval <毫秒>`（默认 1000）、`--json` |

`run` / `continue` 的正文是位置参数，含空格时整体加引号。`--` 之后的内容一律当正文。

## 操作类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa stop <任务号>`（`cancel` 同义） | 排队/暂停任务直接取消，运行中任务登记取消请求 | `--json` |
| `pisa merge <任务号>` | 验证工作副本后快进合并到主干，记 merge 副作用；成功时**退出码 1** | `--force`、`--json` |
| `pisa rewind <任务号>` | 预览撤销动作；带 `--yes` 才执行 | `--yes`、`--json` |
| `pisa pause` | 暂停执行器：不再领取排队任务 | `--json` |
| `pisa resume` | 恢复执行器：下一轮调度继续领任务 | `--json` |

暂停状态写进 `meta` 表，守护进程重启后仍是暂停。`merge` 后需要重启守护进程让新代码生效；`PISA_SUPERVISED=1` 时守护进程自己退出，交给 supervisor 拉起。

## 查询类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa status` | 看板 + 守护进程心跳 + 执行器状态 | `--repo <别名>`、`--json` |
| `pisa list` | 任务列表 | `--repo`、`--status`、`--limit`（默认 20）、`--pr <编号>`、`--github-repo <owner/repo>`、`--json` |
| `pisa show <任务号>` | 单个任务详情与副作用 | `--json` |
| `pisa logs <任务号>` | 任务日志尾部 | `--tail <行数>`（默认 80）、`--json` |
| `pisa repos` | 配置的仓库与授权状态（读本地配置，不需要守护进程） | `--json` |
| `pisa help` | 用法与退出码 | 无 |

`--status` 可选：`queued`、`running`、`paused`、`succeeded`、`failed`、`cancelled`、`rewound`。

## JSON 形状

`run` / `continue`：

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
  "endedAt": null,
  "message": "已接单 · t_20261118_ab12cd"
}
```

`--wait --json` 只输出最终任务对象（不再有入队时的第二个 JSON）。`wait --json` 输出同样字段；超时时输出 `{"id","status","timeout":true}`。

`retry --json` 额外带 `retriedFrom`（原任务号）与 `ticketId`。

`status --json`：

```json
{
  "daemon": { "alive": true, "ageMs": 412, "lastBeat": 1763424000000 },
  "executor": { "paused": false, "running": 1, "concurrency": 1 },
  "counts": { "queued": 1, "running": 1, "paused": 0, "succeeded": 3, "failed": 0, "cancelled": 0, "rewound": 0 },
  "total": 5,
  "repos": ["demo"],
  "repo": null,
  "running": [Task],
  "queued": [Task],
  "finished": [Task]
}
```

`list --json` 输出任务数组；`show --json` 输出单个任务；`logs --json` 输出 `{"ok","id","lines"}`；`repos --json` 输出数组。字段与上面一致。

## 退出码

| 码 | 语义 |
| --- | --- |
| 0 | 正常 |
| 1 | 需重启（`merge` 已落盘） |
| 2 | 部件错误：任务失败、找不到、状态冲突、等待超时、API 连不上、用法错误 |
| 3 | 待配置：配置文件缺失、缺 token、token 不匹配、白名单或仓库不可用 |

## 配置要点

- `repos[].alias` 是 `--repo` 的取值；不传时用第一个仓库。
- `whitelist.repos` 非空时，只有列出的别名可提交；`pisa repos` 会标出 `allowed`。
- 相对 `stateDir` 与 `repos[].path` 以配置文件目录为基准。
- CLI 不再连接 `<stateDir>/pisa.db`；所有状态读写都经管理 API。排查时只读打开库，不要在 CLI 运行时手工写入。
- 管理 API 只接受请求头或 cookie 里的 token；查询参数里的 token 会被拒绝（只有 `/ui` 与 `/` 允许）。
- 日志在 `<stateDir>/logs/<任务号>.log`，由 `pisa logs` 经 API 读取。
