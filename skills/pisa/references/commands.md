# 命令表

所有命令都是一次性进程：执行完即退出，不占终端。`pisa` 是守护进程管理接口的客户端——所有读写都发到 `127.0.0.1:<web.port>`，token 从 `web.tokenEnv`（默认 `PISA_WEB_TOKEN`）指向的环境变量读取。

默认读 `PISA_CONFIG`，否则从当前目录向上找 `pisa.config.json`；也可用 `--config <path>`。守护进程没在跑时，除 `help` 外的命令都以 1 退出。

## 提交类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa run <需求>` | 新建 queued 任务（`task` 同义） | `--repo <别名>`、`--event-id <幂等键>`、`--requester <名字>`、`--wait`、`--timeout <秒>`、`--interval <毫秒>`、`--json` |
| `pisa continue <任务号> <新要求>` | 在原分支上续跑 | 同上（`--repo` 被忽略，继承父任务仓库） |
| `pisa wait <任务号>` | 阻塞到终态 | `--timeout <秒>`（默认 1800）、`--interval <毫秒>`（默认 1000）、`--json` |
| `pisa retry <任务号>` | 复制失败/已取消任务的需求重开，输出新任务号 | `--json` |
| `pisa cancel <任务号>` | 取消任务（`stop` 同义） | `--json` |
| `pisa resume <任务号>` | 恢复 `paused` 任务 | `--json` |

`run` / `continue` 的正文是位置参数，含空格时整体加引号。`--` 之后的内容一律当正文。

## 交付类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa merge <任务号>` | 验证工作副本后快进合并到主干、推送、关 PR | `--force`（跳过并发检查）、`--json` |
| `pisa rewind <任务号>` | 撤销已交付的副作用；不带 `--yes` 只出计划 | `--yes`、`--json` |

两者都走与 IM 命令相同的校验；失败按原因返回 2（状态不对）或 3（任务不存在）。

## 查询类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa status` | 队列、执行器与健康快照 | `--json` |
| `pisa list` | 任务列表 | `--repo`、`--status`、`--limit`（默认 20）、`--pr <编号>`、`--json` |
| `pisa show <任务号>` | 单个任务详情（含副作用与日志尾部） | `--json` |
| `pisa logs <任务号>` | 任务日志尾部 | `--tail <行数>`（默认 80）、`--json` |
| `pisa executor` | 查看执行器状态；`pause` / `resume` 切换 | `--json` |
| `pisa repos` | 配置的仓库与授权状态 | `--json` |
| `pisa help` | 用法与退出码 | 无 |

`--status` 可选：`queued`、`running`、`paused`、`succeeded`、`failed`、`cancelled`、`rewound`。

## JSON 形状

任务对象（`run`、`show`、`list`、看板同源）：

```json
{
  "id": "t_20261118_ab12cd",
  "status": "queued",
  "statusLabel": "排队",
  "stage": "queued",
  "stageLabel": "等执行",
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
  "duration": "0s"
}
```

`run --json` / `continue --json` 输出任务对象加一行 `message`（入队回执）；`--wait --json` 只输出最终任务对象，不带 `message`。接口本身的响应是 `{ ok, taskId, message, task }`。`wait --json` 输出同样字段；超时输出 `{"id","status","timeout":true}` 并以 1 退出。

`status --json`：

```json
{
  "ok": true,
  "daemon": { "alive": true, "ageMs": 412, "lastBeat": 1763424000000 },
  "executor": { "paused": false, "running": 1, "limit": 2 },
  "counts": { "queued": 1, "running": 1, "paused": 0, "succeeded": 3, "failed": 0, "cancelled": 0, "rewound": 0 },
  "total": 5,
  "running": [Task],
  "queued": [Task],
  "finished": [Task],
  "last24h": { "finished": 4, "succeeded": 3, "failed": 1, "successRate": 0.75, "durationSamples": 3, "p50Ms": 60000, "p95Ms": 180000 },
  "repos": [{ "alias": "demo", "path": "/path/demo", "allowed": true }],
  "text": "看板文本"
}
```

`show --json` 返回 `{ ok, task, effects, logTail }`；`logs --json` 返回字符串数组；`repos --json` 返回数组。

## 退出码

| 码 | 语义 |
| --- | --- |
| 0 | 正常 |
| 1 | 需要重启：控制面不可达、心跳过期、执行器暂停、任务 `paused`、`wait` 超时 |
| 2 | 部件错误：任务失败、动作被状态拒绝、合并/撤销失败、接口 5xx |
| 3 | 待配置或用错：缺配置、缺 token 或 token 不符、仓库不可用、任务不存在、参数错误 |

## 配置要点

- `repos[].alias` 是 `--repo` 的取值；不传时用第一个仓库。
- `whitelist.repos` 非空时，只有列出的别名可提交；`pisa repos` 会标出 `allowed`。
- 相对 `stateDir` 与 `repos[].path` 以配置文件目录为基准。
- 提交需要 `web.tokenEnv` 指向的 token 已设置；没设时退出 3，不会去读守护进程打印的一次性 token。
- 状态目录里的 `pisa.db` 只由守护进程读写；不要在 CLI 运行时手动改库。
- 日志在 `<stateDir>/logs/<任务号>.log`，经 `GET /api/tasks/<任务号>/logs` 读取。
