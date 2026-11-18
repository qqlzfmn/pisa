# 命令表

所有命令都是一次性进程：执行完即退出，不占终端。默认读 `PISA_CONFIG`，否则从当前目录向上找 `pisa.config.json`；也可用 `--config <path>`。

## 提交类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa task <需求>` / `pisa run <需求>` | 新建 queued 任务（两个名字等价） | `--repo <别名>`、`--event-id <幂等键>`、`--requester <名字>`、`--wait`、`--timeout <秒>`、`--interval <毫秒>`、`--json` |
| `pisa continue <任务号> <新要求>` | 在原分支上续跑 | 同上（`--repo` 被忽略，继承父任务仓库） |
| `pisa wait <任务号>` | 阻塞到终态 | `--timeout <秒>`（默认 1800）、`--interval <毫秒>`（默认 1000）、`--json` |
| `pisa cancel <任务号>` | 取消任务（走管理接口，服务器已死时直接结束遗留 running） | `--json` |
| `pisa retry <任务号>` | 失败/取消/撤销的任务重新排队，重复调用返回同一条重试任务 | `--json` |

`task` / `continue` 的正文是位置参数，含空格时整体加引号。`--` 之后的内容一律当正文。

## 查询类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa status` | 看板 + 守护进程心跳 + 执行器 + 健康结论；退出码取健康码 | `--json` |
| `pisa list` | 任务列表 | `--repo`、`--status`、`--limit`（默认 20）、`--pr <编号>`、`--github-repo <owner/repo>`、`--json` |
| `pisa show <任务号>` | 单个任务详情 | `--json` |
| `pisa logs <任务号>` | 任务日志尾部 | `--tail <行数>`（默认 80）、`--json` |
| `pisa repos` | 配置的仓库与授权状态 | `--json` |
| `pisa help` | 用法与退出码 | 无 |

`--status` 可选：`queued`、`running`、`paused`、`succeeded`、`failed`、`cancelled`、`rewound`。

## 管理类（需要守护进程开着 web）

这些命令调 `127.0.0.1:<web.port>` 的管理接口，token 取自 `web.tokenEnv`。「状态不允许」返回 4，「找不到 / 缺前置条件」返回 3，「接口不可达」返回 1。

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa merge <任务号>` | 与 `/pisa merge` 同一条路径：验证副本跑测试后快进合入 | `--force`、`--json` |
| `pisa rewind <任务号>` | 撤销计划预览 | `--yes` 执行、`--json` |
| `pisa executor pause` / `resume` | 暂停/恢复调度；执行中的任务不受影响 | `--json` |

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

`status --json`（接口可达时）：

```json
{
  "source": "api",
  "ok": true,
  "daemon": { "alive": true, "ageMs": 412, "lastBeat": 1763424000000 },
  "executor": { "paused": false, "active": 1, "concurrency": 2 },
  "health": { "code": 0, "issues": [] },
  "counts": { "queued": 1, "running": 1, "paused": 0, "succeeded": 3, "failed": 0, "cancelled": 0, "rewound": 0 },
  "total": 5,
  "repos": ["demo"],
  "running": [Task],
  "queued": [Task],
  "finished": [Task]
}
```

接口不可达时 `source` 为 `"local"`，`executor` 为 `null`，其余字段照旧；退出码仍是本地算出的健康码。

`list --json`、`show --json`、`repos --json` 都是数组或对象，字段与上面一致。管理命令 `--json` 输出 `{ok, code, taskId, message}`。

`logs --json` 输出 `{"id":"t_...","lines":["...","..."]}`。

## 退出码

| 码 | 语义 |
| --- | --- |
| 0 | 成功；`status` 的健康码也是 0 |
| 1 | 任务失败（`failed`），或系统需人工处理：配置改了要重启、管理接口不可达；`status` 的健康码 1 |
| 2 | 用法、配置、仓库鉴权错误，或管理动作执行失败 |
| 3 | 任务号不存在，或待配置（如 `web.tokenEnv` 未设置）；`status` 的健康码 3 |
| 4 | 任务状态不允许（paused / cancelled / rewound，或终态再取消/重试） |
| 5 | `wait` 超时 |

## 配置要点

- `repos[].alias` 是 `--repo` 的取值；不传时用第一个仓库。
- `whitelist.repos` 非空时，只有列出的别名可提交；`pisa repos` 会标出 `allowed`。
- 相对 `stateDir` 与 `repos[].path` 以配置文件目录为基准。
- CLI 与守护进程共用 `<stateDir>/pisa.db`；不要在 CLI 运行时手动改库。
- 日志在 `<stateDir>/logs/<任务号>.log`。
