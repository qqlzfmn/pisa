# 命令表

所有命令都是一次性进程：执行完即退出，不占终端。默认读 `PISA_CONFIG`，否则从当前目录向上找 `pisa.config.json`；也可用 `--config <path>`。

`status` / `show` / `logs` / `run` / `pause` / `stop` / `retry` / `merge` / `rewind` 走守护进程的本机管理接口：地址与 token 在 `<stateDir>/api.json`（0600），CLI 自动发现；也可用 `PISA_API_URL` + `PISA_API_TOKEN` 覆盖。`task` / `continue` / `wait` / `list` / `repos` 直连 `<stateDir>/pisa.db`，守护进程没起时也能用。

## 提交类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa task <需求>` | 新建 queued 任务 | `--repo <别名>`、`--event-id <幂等键>`、`--requester <名字>`、`--wait`、`--timeout <秒>`、`--interval <毫秒>`、`--json` |
| `pisa continue <任务号> <新要求>` | 在原分支上续跑 | 同上（`--repo` 被忽略，继承父任务仓库） |
| `pisa run <需求>` | 提交后阻塞到终态 | `--repo`、`--event-id`、`--timeout <秒>`、`--interval <毫秒>`、`--json` |
| `pisa wait <任务号>` | 阻塞到终态 | `--timeout <秒>`（默认 1800）、`--interval <毫秒>`（默认 1000）、`--json` |

`task` / `continue` / `run` 的正文是位置参数，含空格时整体加引号。`--` 之后的内容一律当正文。

## 操作类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa stop <任务号>` | 取消任务（原名 `cancel`，已移除） | `--json` |
| `pisa retry <任务号>` | 重试 failed / cancelled 任务，返回新任务号 | `--json` |
| `pisa merge <任务号>` | 合并已完成任务的分支 | `--json` |
| `pisa rewind <任务号>` | 打印撤销计划；`--yes` 才执行 | `--yes`、`--json` |
| `pisa pause` | 暂停补位，运行中的任务照常收尾 | `--json` |
| `pisa resume` | 恢复补位 | `--json` |

暂停状态落库，跨重启保留。`retry` 有分支时按续跑处理（复用分支、上下文与 PR），没有分支按原需求新开；两种都生成新任务，不改写历史任务。

## 查询类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa status` | 看板 + 执行器 + 守护进程心跳 | `--json` |
| `pisa list` | 任务列表 | `--repo`、`--status`、`--limit`（默认 20）、`--pr <编号>`、`--github-repo <owner/repo>`、`--json` |
| `pisa show <任务号>` | 单个任务详情（含副作用与日志尾部） | `--json` |
| `pisa logs <任务号>` | 任务日志尾部 | `--tail <行数>`（默认 80）、`--json` |
| `pisa repos` | 配置的仓库与授权状态 | `--json` |
| `pisa help` | 用法与退出码 | 无 |

`--status` 可选：`queued`、`running`、`paused`、`succeeded`、`failed`、`cancelled`、`rewound`。

## JSON 形状

`task` / `continue` / `run`：

```json
{
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
  "message": "已入队"
}
```

`--wait --json` 只输出最终任务对象（不再有入队时的第二个 JSON）。`run --json` 输出 `{ task, effects, logTail }`。`wait --json` 输出任务对象；超时时输出 `{"id","status","timeout":true}`。

`status --json`：

```json
{
  "daemon": { "alive": true, "ageMs": 412, "lastBeat": 1763424000000 },
  "executor": { "paused": false, "running": 1, "queued": 1, "concurrency": 2 },
  "counts": { "queued": 1, "running": 1, "paused": 0, "succeeded": 3, "failed": 0, "cancelled": 0, "rewound": 0 },
  "total": 5,
  "running": [Task],
  "queued": [Task],
  "finished": [Task],
  "last24h": { "finished": 5, "succeeded": 4, "failed": 1, "successRate": 0.8, "durationSamples": 5, "p50Ms": 184000, "p95Ms": 712000 }
}
```

`show --json` / `logs --json`：`{ "task": Task, "effects": [...], "logTail": ["HH:MM:SS stage msg", ...] }`。

`stop` / `retry` / `merge` / `rewind --yes`：`{ ok, status?, taskId?, message }`；`rewind` 不加 `--yes` 时是 `{ ok, plan }`。`pause` / `resume`：`{ ok, executor }`。

`list --json`、`repos --json` 是数组。每个任务都带只读的 `stage` / `stageLabel`（由 `status`、分支、PR 派生，回答在等谁），`status` 保持不变。

## 退出码

| 码 | 语义 |
| --- | --- |
| 0 | 正常 |
| 1 | 需重启：管理接口不可达，或 `/state` 报心跳过期 |
| 2 | 部件错误：任务 failed、接口 5xx、合并/撤销未成功 |
| 3 | 待配置：没有 `api.json` / token，或 401 / 403 |
| 4 | 用法：参数、仓库别名、白名单 |
| 5 | 找不到：任务号不存在 |
| 6 | 不可运行：状态不允许（终态取消、对非失败任务 retry 等） |
| 7 | 等待超时 |

## 配置要点

- `repos[].alias` 是 `--repo` 的取值；不传时用第一个仓库。
- `whitelist.repos` 非空时，只有列出的别名可提交；`pisa repos` 会标出 `allowed`。
- 相对 `stateDir` 与 `repos[].path` 以配置文件目录为基准。
- 管理接口只监听 `127.0.0.1`，只认请求头 token；cookie 与查询参数无效。
- 日志在 `<stateDir>/logs/<任务号>.log`。
