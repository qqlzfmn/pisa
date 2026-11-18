# 命令表

所有命令都是一次性进程：执行完即退出，不占终端。默认读 `PISA_CONFIG`，否则从当前目录向上找 `pisa.config.json`；也可用 `--config <path>`。

CLI 不直接读数据库：它读 `<stateDir>/api.json` 里的端口与令牌，调用守护进程的管理接口。**守护进程必须在跑，且 `api.enabled` 为 true**，否则管理类命令返回退出码 `3`。

## 提交类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa run <需求>` | 新建 queued 任务 | `--repo <别名>`、`--event-id <幂等键>`、`--requester <名字>`、`--wait`、`--timeout <秒>`、`--interval <毫秒>`、`--json` |
| `pisa continue <任务号> <新要求>` | 在原分支上续跑 | 同上（`--repo` 被忽略，继承父任务仓库） |
| `pisa wait <任务号>` | 阻塞到终态 | `--timeout <秒>`（默认 1800）、`--interval <毫秒>`（默认 1000）、`--json` |
| `pisa retry <任务号>` | 失败/取消的任务重跑一份 | `--json` |
| `pisa stop <任务号>` | 取消任务 | 无 |

`run` / `continue` 的正文是位置参数，含空格时整体加引号。`--` 之后的内容一律当正文。

## 查询类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa status` | 看板 + 守护进程心跳 + 执行器暂停状态 | `--json` |
| `pisa list` | 任务列表 | `--repo`、`--status`、`--limit`（默认 20）、`--pr <编号>`、`--github-repo <owner/repo>`、`--json` |
| `pisa show <任务号>` | 单个任务详情 | `--json` |
| `pisa logs <任务号>` | 任务日志尾部 | `--tail <行数>`（默认 80） |
| `pisa repos` | 配置的仓库与授权状态 | `--json` |
| `pisa help` | 用法与退出码 | 无 |

`--status` 可选：`queued`、`running`、`paused`、`succeeded`、`failed`、`cancelled`、`rewound`。

## 操作类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa merge <任务号>` | 临时副本验证 + `--ff-only` 合入主干 | 无 |
| `pisa rewind <任务号>` | 预览撤销计划 | `--yes` 执行、`--json` |
| `pisa executor pause` | 暂停派发（运行中的任务不打断） | 无 |
| `pisa executor resume` | 恢复派发 | 无 |

## JSON 形状

`run` / `continue` / `retry`：

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
  "executor": { "paused": false },
  "counts": { "queued": 1, "running": 1, "paused": 0, "succeeded": 3, "failed": 0, "cancelled": 0, "rewound": 0 },
  "total": 5,
  "running": [Task],
  "queued": [Task],
  "finished": [Task]
}
```

`rewind --json`：`{"plan":{"task":Task,"merge":"...","actions":[...],"irreversible":[...],"notes":[...]},"results":null|[...],"rewound":false}`；`results` 为 `null` 表示只预览。

`list --json`、`show --json`、`repos --json` 都是数组或对象，字段与上面一致。

## 退出码

| 码 | 语义 |
| --- | --- |
| 0 | 成功 |
| 1 | 需要重启或重连：`api.json` 缺失、连不上接口、令牌失效、`status` 心跳过期 |
| 2 | 命令失败：任务失败或取消、等待超时、接口拒绝、用法错误 |
| 3 | 待配置：配置文件缺失、管理接口未启用、仓库未授权/不存在/不是 git 仓库 |

## 配置要点

- `repos[].alias` 是 `--repo` 的取值；不传时用第一个仓库。
- `whitelist.repos` 非空时，只有列出的别名可提交；`pisa repos` 会标出 `allowed`。
- 相对 `stateDir` 与 `repos[].path` 以配置文件目录为基准。
- 管理接口：`"api": { "enabled": true, "port": 7801 }`；端口与令牌写在 `<stateDir>/api.json`，守护进程退出时删除。
- 日志在 `<stateDir>/logs/<任务号>.log`。
