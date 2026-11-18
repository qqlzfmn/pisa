# 命令表

所有命令都是一次性进程：执行完即退出，不占终端。CLI 是管理接口的客户端，只发 HTTP 请求，不打开数据库；因此守护进程必须在跑，且配置里 `web.enabled` 为 `true`。默认读 `PISA_CONFIG`，否则用当前目录的 `pisa.config.json`；也可用 `--config <path>`。

token 取 `${web.tokenEnv}`，没配就读守护进程写入的 `<stateDir>/mgmt.token`。

## 提交类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa run <需求>` | 新建 queued 任务 | `--repo <别名>`、`--event-id <幂等键>`、`--wait`、`--timeout <秒>`、`--interval <秒>`、`--json` |
| `pisa continue <任务号> <新要求>` | 在原分支上续跑 | `--wait`、`--timeout <秒>`、`--interval <秒>`、`--json` |
| `pisa wait <任务号>` | 阻塞到终态 | `--timeout <秒>`（默认 900）、`--interval <秒>`（默认 2）、`--json` |
| `pisa retry <任务号>` | 同需求重跑终态任务 | `--wait`、`--json` |
| `pisa stop <任务号>` | 停止任务 | `--json` |

`run` / `continue` 的正文是位置参数，含空格时整体加引号。

## 查询类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa status` | 看板 + 执行器状态 + 24h 指标 | `--json` |
| `pisa list` | 任务列表 | `--repo`、`--status`、`--limit`（默认 20）、`--pr <编号>`、`--github-repo <owner/repo>`、`--json` |
| `pisa show <任务号>` | 任务详情、副作用与日志 | `--tail <行数>`（默认 200）、`--json` |
| `pisa logs <任务号>` | 只看日志尾部 | `--tail <行数>`（默认 200）、`--json` |
| `pisa help` | 用法与退出码 | 无 |

`--status` 可选：`queued`、`running`、`paused`、`succeeded`、`failed`、`cancelled`、`rewound`。

## 运维类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa pause` | 暂停派活，运行中的任务继续 | `--resume` 恢复 |
| `pisa merge <任务号>` | 合并分支到主干 | `--confirm`（必需）、`--force` |
| `pisa rewind <任务号>` | 撤销已交付的副作用 | `--yes` 执行，缺省只预览 |

`pisa merge` 之后若输出「重启后生效」，进程以 `1` 退出——把重启交给看护进程或人。

## JSON 形状

`run` / `continue` / `retry`（不带 `--wait`）：

```json
{
  "ok": true,
  "taskId": "t_20261118_ab12cd",
  "task": {
    "id": "t_20261118_ab12cd",
    "status": "queued",
    "stage": "working/queued",
    "stageLabel": "等空闲槽位",
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
    "duration": "—"
  },
  "message": "已入队"
}
```

`--wait --json`、`wait --json` 只输出最终任务对象（上面的 `task`）。

`status --json`：

```json
{
  "ok": true,
  "daemon": { "alive": true, "ageMs": 412, "lastBeat": 1763424000000 },
  "executor": { "paused": false, "active": 1, "concurrency": 2 },
  "repos": ["demo"],
  "counts": { "queued": 1, "running": 1, "paused": 0, "succeeded": 3, "failed": 0, "cancelled": 0, "rewound": 0 },
  "total": 5,
  "running": [Task],
  "queued": [Task],
  "finished": [Task],
  "last24h": { "finished": 4, "succeeded": 3, "failed": 1, "successRate": 0.75, "durationSamples": 4, "p50Ms": 61000, "p95Ms": 190000 }
}
```

`list --json` 输出 `{"ok":true,"tickets":[Task]}`；`show --json` 输出 `{"ok":true,"task":Task,"effects":[...],"logTail":[...]}`。

错误体统一为 `{"ok":false,"code":"usage|config|auth|state","error":"..."}`。

## 退出码

| 码 | 语义 | 常见原因 |
| --- | --- | --- |
| 0 | 正常 | 命令成功；`wait` 的任务为 `succeeded` |
| 1 | 需重启 | `merge` 已合入但当前不是看护模式，改动要重启守护进程才生效 |
| 2 | 部件错误 | 连不上管理接口、4xx/5xx、任务未成功（failed/cancelled/rewound）、`wait` 超时、用法错误、任务号不存在 |
| 3 | 待配置 | 缺配置文件、`web.enabled` 未开、token 缺失或无效、仓库未授权 |

## 配置要点

- `repos[].alias` 是 `--repo` 的取值；不传时用第一个仓库。
- `whitelist.repos` 非空时，只有列出的别名可提交；越权时退出码为 `3`。
- 相对 `stateDir` 与 `repos[].path` 以配置文件目录为基准。
- 日志在 `<stateDir>/logs/<任务号>.log`，读日志走 `pisa logs`，不要直接翻库。
