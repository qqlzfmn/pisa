---
name: pisa
description: 把编码任务派给本机 pisa 守护进程并跟踪结果。用于需要异步执行、独立工作副本、生成分支或 PR 的编码任务；也可查询任务状态、日志、取消任务。适用于 Claude Code、Codex、OpenClaw 等能执行 shell 的 agent。
---

# 用 pisa 派活

pisa 是一个常驻守护进程：接收任务，在独立 git 工作副本里跑编码 agent，提交到 `pisa/<任务号>` 分支，可选推送与开 PR。你的 agent 只负责提交任务、轮询、验收，不负责执行。

## 什么时候用

- 任务会改代码，且希望隔离在独立分支/工作副本里
- 一次要做多件事，想并行排队，不想占住当前会话
- 需要留下任务号、分支、PR 作为可追溯记录
- CI 修复、Issue 实现、PR 评论迭代这类"提交后等结果"的活

## 什么时候不用

- 只读分析、问答、查文档：直接在当前会话做
- 需要即时交互、逐步确认的改动：pisa 是异步的，不适合
- 目标仓库不是本机 git 仓库，或没在 `pisa.config.json` 的 `repos` 里
- 守护进程没运行且你无法启动它：任务只会排队

## 前置检查

先确认 `pisa` 命令在 PATH 里：

```bash
cd <pisa 仓库> && bun link     # 一次性；把 bin.pisa 链到 PATH
# 或直接调用：bun /path/to/pisa/src/cli.ts <命令>
command -v pisa || bun run src/cli.ts help
```

再按顺序确认：

```bash
pisa repos --json                              # 配置了哪些仓库、是否授权
pisa status --json                             # 守护进程是否在跑
```

`status --json` 里 `daemon.alive` 为 `false` 时，`pisa task` 仍会入队，但 stderr 会警告，任务不会自己开始。此时先让人类启动守护进程（`bun run src/index.ts` 或 launchd），否则不要进入轮询。

## 标准流程

1. **选仓库**：`pisa repos --json`，用返回的 `alias`。不要猜仓库路径。
2. **写 brief**：按 [references/briefs.md](references/briefs.md) 的模板，把问题、证据、范围、验收写清楚。brief 是 Worker 唯一的需求来源，缺证据会得到猜测式修复。
3. **提交**：

   ```bash
   pisa task "<brief>" --repo <别名> --event-id "<幂等键>" --json
   ```

   `--event-id` 用稳定值（如 `ci:<run-id>`、`issue:<n>`），重试不会建重复任务。
4. **轮询**：优先 `pisa wait <id> --timeout <秒> --json`，让 CLI 阻塞到终态；需要边等边做别的事时用 `pisa status --json` 或 `pisa list --status running --json`。
5. **验收**：看退出码、`summary`、`branch`、`prUrl`；需要细节时 `pisa logs <id> --tail 150`。
6. **迭代**：同一分支继续改，用 `pisa continue <父任务号> "<新要求>" --json`，不要新建任务重做。

## 轮询策略

不要写 `sleep 5 && pisa show` 的固定循环；`pisa wait` 已经做完了：

```bash
pisa wait <id> --timeout 900 --json      # 阻塞到终态，退出码 0/1/4/5
```

- 有 CI 时限：`--timeout` 小于 CI 超时，留出收尾时间。
- 多任务并行：先全部 `task` 拿到 id，再对每个 id `wait`；或定期 `pisa status --json` 看整体。
- 等待超时（5）：不要重提，先 `pisa show <id> --json`；仍 running 就继续等。
- 需要边等边做别的事：单次查 `pisa status --json`，不要高频轮询。
- 守护进程死亡：`status --json.daemon.alive=false`，任务变不动；交给人恢复，不要重复提交。

## 退出码即契约

| 码 | 含义 | 你的动作 |
| --- | --- | --- |
| 0 | 成功 | 读 `summary` / `prUrl`，做自己的验收 |
| 1 | 任务失败 | 读 `error` 与日志，判断是 brief 问题还是环境问题 |
| 2 | 用法或配置错误 | 修参数/配置，不要原样重试 |
| 3 | 找不到任务 | 检查任务号；不要假设任务存在 |
| 4 | 任务不可运行 | paused / cancelled / rewound，交给人处理 |
| 5 | 等待超时 | 任务可能仍在跑；用 `pisa status` 继续观察，不要重复提交 |

`pisa status` 不复用上表：`0` 正常、`1` 需重启（守护进程心跳丢失）、`2` 部件错误（外部动作重试用尽）、`3` 待配置（`repos` 为空）。同时命中时取 3 > 2 > 1。

## 常用命令速查

```bash
pisa task "<brief>" --repo demo --event-id ci:123 --wait --timeout 1200 --json
pisa wait <id> --timeout 600 --json
pisa status --json
pisa list --repo demo --status succeeded --limit 10 --json
pisa show <id> --json
pisa logs <id> --tail 120
pisa cancel <id>
pisa continue <id> "按评论第 2 点改" --json
```

完整参数与 JSON 字段见 [references/commands.md](references/commands.md)。

## 失败与边界

- 常见失败、判别方法、重试策略：[references/failures.md](references/failures.md)
- CLI 能做什么、不能做什么：[references/limits.md](references/limits.md)
- 三个可直接照抄的场景：[references/scenarios.md](references/scenarios.md)

## 硬规则

- 不要用 `pisa` 执行 `git commit`、`git push` 或开 PR；这些由 pisa 的交付阶段完成。你只在任务完成后验收结果。
- 不要在 brief 里写"随便修一下""看着办"；写成可验证的验收条件。
- 不要重复提交同一需求；先 `pisa list --json` 查有没有在跑或已完成的任务。
- 不要让多个任务改同一个仓库的同一分支；pisa 每个任务默认独立分支，续跑才共享分支。
- 等待超时不等于失败；先查状态再决定是否重提。
