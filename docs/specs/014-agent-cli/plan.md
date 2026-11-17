# 014 · 方案

## 1. 结构

```
agent ──bash──> pisa CLI ──SQLite(WAL)──> pisa.db <──SQLite── 守护进程
                   │                                      │
                   └── 读取 pisa.config.json ──────────────┘
```

- CLI 只做三件事：校验输入、写一个 queued 任务、读任务与日志。
- 执行、交付、回帖仍由守护进程的 `Router` 负责；CLI 不引入第二套状态机。
- 状态机唯一入口仍是 `Store.transition`。

## 2. 模块

| 文件 | 职责 |
| --- | --- |
| `src/cli.ts` | 参数解析、命令分发、输出与退出码 |
| `src/config.ts` | `findConfig` 向上查找；`loadConfig` 锚定相对路径 |
| `src/store.ts` | `beat` / `lastBeat`、`taskByEvent`、`insertTaskOnce`、`listTasks`、`tasksByPr` |
| `src/status.ts` | 看板、心跳判定、时长与预览格式化（Router 与 CLI 共用） |
| `src/ids.ts` | 任务号生成（Router 与 CLI 共用） |
| `src/task-context.ts` | 续跑上下文（Router 与 CLI 共用） |

## 3. 关键决策

### CLI 直接写库而不是走 webhook

webhook 需要守护进程开启且持有 token，离线排障与 CI 都不方便；SQLite 已是唯一事实源，WAL 支持多进程读写。代价是 CLI 与守护进程共享 schema，因此 schema 变更必须同时兼容两者。

### 心跳放 `meta` 表

不新增文件与端口；`Router.start` 已有的 800ms 调度循环顺带写时间戳。CLI 用 10s 阈值判断「守护进程未运行」，只警告不阻止入队，避免启动顺序导致任务丢失。

### 路径锚定到配置文件

`stateDir` 与 `repos[].path` 的相对路径以配置文件目录解析。守护进程从仓库根启动、CLI 从子目录或 worktree 启动时，仍指向同一状态目录与仓库。

### 退出码固定

agent 需要可编程分支，退出码即契约；`--wait` 把轮询封装进 CLI，避免每个 agent 各写一套 sleep 循环。

### `--wait --json` 抑制入队输出

否则两个 JSON 对象拼接，任何解析器都会失败。非 JSON 模式仍先打印任务号，方便人看到进度。

## 4. 风险

- 守护进程与 CLI 同时写库：WAL + 单事务 `insertTaskOnce` 足够；`claimQueued` 本来就是原子占位。
- 心跳误判：进程忙到 10s 没跑定时器几乎不可能；阈值只影响警告。
- 旧配置依赖 cwd 的相对路径：行为变化仅影响从非配置文件目录启动的场景，正是要修的部分。

## 5. 验证

- `tests/cli.test.ts`：16 个用例覆盖提交、幂等、鉴权、续跑、等待、查询、取消、日志、路径锚定。
- `bun test` 全量回归。
- `bunx tsc --noEmit`。
- 临时目录端到端：真实 `bun src/cli.ts` 提交并查询。
