# 命令表

所有命令都是一次性进程：执行完即退出，不占终端。默认读 `PISA_CONFIG`，否则从当前目录向上找 `pisa.config.json`；也可用 `--config <path>`。

## 提交类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa task <需求>` | 新建 queued 任务 | `--repo <别名>`、`--event-id <幂等键>`、`--requester <名字>`、`--wait`、`--timeout <秒>`、`--interval <毫秒>`、`--json` |
| `pisa continue <任务号> <新要求>` | 在原分支上续跑 | 同上（`--repo` 被忽略，继承父任务仓库） |
| `pisa wait <任务号>` | 阻塞到终态 | `--timeout <秒>`（默认 1800）、`--interval <毫秒>`（默认 1000）、`--json` |
| `pisa cancel <任务号>` | 取消任务 | 无 |

`task` / `continue` 的正文是位置参数，含空格时整体加引号。`--` 之后的内容一律当正文。

## 查询类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa status` | 看板 + 守护进程心跳 + 健康结论 | `--json` |
| `pisa patrol` | 一次性运维巡检，正常无输出 | `--json` |
| `pisa list` | 任务列表 | `--repo`、`--status`、`--limit`（默认 20）、`--pr <编号>`、`--github-repo <owner/repo>`、`--json` |
| `pisa show <任务号>` | 单个任务详情 | `--json` |
| `pisa logs <任务号>` | 任务日志尾部 | `--tail <行数>`（默认 80） |
| `pisa repos` | 配置的仓库与授权状态 | `--json` |
| `pisa help` | 用法与退出码 | 无 |

`--status` 可选：`queued`、`running`、`paused`、`succeeded`、`failed`、`cancelled`、`rewound`。

## JSON 形状

`task` / `continue`：

```json
{
  "id": "t_20261118_ab12cd",
  "status": "queued",
  "repo": "demo",
  "branch": null,
  "prUrl": null,
  "baseRef": null,
  "prompt": "修 CI：...",
  "summary": null,
  "error": null,
  "createdAt": 1763424000000,
  "startedAt": null,
  "endedAt": null,
  "message": "已入队"
}
```

`--wait --json` 只输出最终任务对象（不再有入队时的第二个 JSON）。`wait --json` 输出同样字段；超时时输出 `{"id","status","timeout":true}`。

`status --json`：

```json
{
  "daemon": { "alive": true, "ageMs": 412, "lastBeat": 1763424000000 },
  "health": { "code": 0, "level": "ok", "issues": [] },
  "counts": { "queued": 1, "running": 1, "paused": 0, "succeeded": 3, "failed": 0, "cancelled": 0, "rewound": 0 },
  "total": 5,
  "running": [Task],
  "queued": [Task],
  "finished": [Task]
}
```

`patrol --json`：`{ "health": { "code", "level", "issues" }, "fresh": [OpsIssue], "delivered": boolean, "error"?: string }`。`fresh` 是本次新出现、还没提醒过的问题。

`list --json`、`show --json`、`repos --json` 都是数组或对象，字段与上面一致。

## 退出码

`task` / `continue` / `wait` / `show` / `cancel` 等命令：

| 码 | 语义 |
| --- | --- |
| 0 | 成功 |
| 1 | 任务失败（`failed`），或命令因业务规则被拒 |
| 2 | 用法、配置、仓库鉴权错误 |
| 3 | 任务号不存在 |
| 4 | 任务不可运行（paused / cancelled / rewound） |
| 5 | `wait` 超时 |

`status` / `patrol` 用运维语义，`1`–`3` 与上表不同：

| 码 | 语义 |
| --- | --- |
| 0 | 正常 |
| 1 | 需重启（心跳停止） |
| 2 | 部件错误（已启用组件配置不完整、cron 非法、任务 id 重复） |
| 3 | 待配置（`repos` 为空，或找不到配置文件） |

多个问题同时存在时取最大码。

## 配置要点

- `repos[].alias` 是 `--repo` 的取值；不传时用第一个仓库。
- `whitelist.repos` 非空时，只有列出的别名可提交；`pisa repos` 会标出 `allowed`。
- 相对 `stateDir` 与 `repos[].path` 以配置文件目录为基准。
- CLI 与守护进程共用 `<stateDir>/pisa.db`；不要在 CLI 运行时手动改库。
- 日志在 `<stateDir>/logs/<任务号>.log`。
