# 命令表

所有命令都是一次性进程：执行完即退出，不占终端。默认读 `PISA_CONFIG`，否则从当前目录向上找 `pisa.config.json`；也可用 `--config <path>`。

建单（`run`、`continue`）在本地写库，守护进程不在也不丢任务；其余读写都经守护进程的管理 API（只监听 `127.0.0.1`，凭证取自 `web.tokenEnv` 指向的环境变量），所以要先 `web.enabled: true`。

## 提交类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa run <需求>` | 新建 queued 任务（`task` 是别名） | `--repo <别名>`、`--event-id <幂等键>`、`--requester <名字>`、`--wait`、`--timeout <秒>`、`--interval <毫秒>`、`--json` |
| `pisa continue <任务号> <新要求>` | 在原分支上续跑 | 同上（`--repo` 被忽略，继承父任务仓库） |
| `pisa wait <任务号>` | 阻塞到终态 | `--timeout <秒>`（默认 1800）、`--interval <毫秒>`（默认 1000）、`--json` |
| `pisa retry <任务号>` | 为终态任务再排一次（有分支走 continue 语义） | `--json` |
| `pisa cancel <任务号>` | 取消任务 | 无 |
| `pisa merge <任务号> --yes` | 把成功任务的分支快进合入主干 | `--yes`（必需） |
| `pisa rewind <任务号> [--yes]` | 预览或执行副作用撤销 | `--yes` 才执行 |
| `pisa executor pause\|resume` | 暂停/恢复执行器领取新任务 | 无 |
| `pisa config [--set <patch.json> --yes]` | 查看或保存配置（保存后需重启） | `--json`、`--set`、`--yes` |

`run` / `continue` 的正文是位置参数，含空格时整体加引号。`--` 之后的内容一律当正文。

## 查询类

| 命令 | 作用 | 关键选项 |
| --- | --- | --- |
| `pisa status` | 看板 + 守护进程 + 执行器状态 | `--json` |
| `pisa list` | 任务列表 | `--repo`、`--status`、`--limit`（默认 20）、`--pr <编号>`、`--github-repo <owner/repo>`、`--json` |
| `pisa show <任务号>` | 单个任务详情 | `--json` |
| `pisa logs <任务号>` | 任务日志尾部 | `--tail <行数>`（默认 80，上限 2000）、`--json` |
| `pisa repos` | 配置的仓库与授权状态 | `--json` |
| `pisa help` | 用法与退出码 | 无 |

`--status` 可选：`queued`、`running`、`paused`、`succeeded`、`failed`、`cancelled`、`rewound`。

## JSON 形状

`run` / `continue`：

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

`--wait --json` 只输出最终任务对象（不再有入队时的第二个 JSON）。`wait --json` 输出同样字段；超时时输出 `{"id","status","timeout":true}`。

`status --json`：

```json
{
  "ok": true,
  "daemon": { "alive": true, "ageMs": 412, "lastBeat": 1763424000000 },
  "counts": { "queued": 1, "running": 1, "paused": 0, "succeeded": 3, "failed": 0, "cancelled": 0, "rewound": 0 },
  "total": 5,
  "running": [Task],
  "queued": [Task],
  "finished": [Task],
  "last24h": { "finished": 3, "succeeded": 3, "failed": 0, "successRate": 1, "durationSamples": 3, "p50Ms": 180000, "p95Ms": 400000 },
  "worker": { "concurrency": 2, "running": 1, "paused": false },
  "repos": ["demo"],
  "text": "运行中（1）\n..."
}
```

`list --json` 是平铺的任务数组；`show --json` 是任务对象（不含 `effects` 与 `logTail`，日志用 `logs`）；`logs --json` 是 `{"id","tail","lines":[]}`；`repos --json` 是 `[{"alias","path","remote","baseBranch","allowed"}]`。每个任务都带只读的 `stage` / `stageLabel`（由 `status`、分支、PR 派生，回答在等谁），`status` 保持不变。

`retry --json` 是 `{"ok":true,"taskId":"...","message":"..."}`；`merge` / `rewind` / `executor` / `cancel` 的 `--json` 是 `{"ok","message",...}`。

## 退出码

| 码 | 语义 | 你的动作 |
| --- | --- | --- |
| 0 | 正常 | 按 `--json` 字段判断结果 |
| 1 | 操作成功但需重启 | 仅 `config --set` 会返回；让人重启 pisa |
| 2 | 部件错误 | 用法错误、管理 API 不可达、任务失败/超时、操作被拒（409）；读 stderr 与 `--json` 定位 |
| 3 | 待配置 | 找不到配置文件、`web.enabled` 未开、`web.tokenEnv` 缺失或 token 被拒 |

任务本身失败不再用退出码 1 表达：`wait` / `run --wait` 返回 2，用 `status` 与 `error` 区分「任务失败」和「CLI 出错」。

## 配置要点

- `repos[].alias` 是 `--repo` 的取值；不传时用第一个仓库。
- `whitelist.repos` 非空时，只有列出的别名可提交；`pisa repos` 会标出 `allowed`。
- 相对 `stateDir` 与 `repos[].path` 以配置文件目录为基准。
- 建单时才直接写 `<stateDir>/pisa.db`；其余命令只经管理 API，守护进程停了就退 2。
- 日志在 `<stateDir>/logs/<任务号>.log`，CLI 从管理 API 取尾部。
