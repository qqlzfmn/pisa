# 014 · Agent CLI 与 skill 包

- 状态：implemented
- 关联：001（任务状态机）、010（状态板）、013（rewind 账本）
- 依赖：Bun、SQLite（与守护进程共用同一个库）

## 1. 问题

pisa 的入口只有聊天、webhook 与 GitHub 评论，都是为「人」设计的：提交后要靠 IM 回执，查询要靠 `/pisa status`，agent 没有稳定的命令行入口。换一个 coding agent 就要重新解释如何派活、如何拿任务号、如何判断失败，接入成本无法复用。

## 2. 目标

- 提供一次性 CLI：提交、续跑、等待、查询、取消，不依赖常驻 stdin。
- CLI 与守护进程共用配置和 SQLite，不新增长期协议。
- 心跳可判断「任务会不会被执行」，避免任务静默排队。
- 附 skill 包，让 Claude Code / Codex / OpenClaw 按同一套命令与退出码工作。

## 3. 用户故事

### US-1 派活并拿任务号

作为 coding agent，我运行 `pisa task "修 CI" --repo demo --json`，拿到 `{id,status}`，后续用任务号轮询。

### US-2 等待完成

作为 CI 机器人，我加 `--wait --timeout 900`，命令只在任务终态或超时时返回，退出码区分成功、失败、超时。

### US-3 评论迭代

作为 reviewer agent，我看到 PR 新评论后运行 `pisa continue <任务号> "按评论改"`，新任务落在原分支与原 PR 上。

### US-4 守护进程没开

作为 agent，我提交后看到「心跳已过期」警告，知道任务不会自己跑，而不是无限轮询。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `src/cli.ts`，`runCli(argv, io)` 可进程内测试；`import.meta.main` 时执行并以退出码退出 |
| FR-002 | 命令：`task`、`continue`、`wait`、`status`、`list`、`show`、`logs`、`cancel`、`repos`、`help` |
| FR-003 | 全局 `--config`；缺省用 `PISA_CONFIG`，再缺省从 cwd 向上查找 `pisa.config.json` |
| FR-004 | 所有查询命令支持 `--json`；`task --wait --json` 只输出最终任务 |
| FR-005 | `task` 校验仓库别名、`whitelist.repos`、`isGitRepo`；`--event-id` 重复时返回原任务且不新建 |
| FR-006 | 事件与任务同一 SQLite 事务写入（`Store.insertTaskOnce`） |
| FR-007 | `continue` 要求父任务存在且有分支；继承 `repo`、`baseRef=parent.branch`、`prUrl`，`context` 由 `continuationContext` 生成 |
| FR-008 | 守护进程每 800ms 写心跳（`meta.heartbeat`）；超过 10s 未更新视为未运行，CLI 在 stderr 警告但仍入队 |
| FR-009 | `status` 复用 `formatStatusBoard`；JSON 含 `daemon`、`counts`、`total` 与任务列表 |
| FR-010 | `list` 支持 `--repo`、`--status`、`--limit`、`--pr`、`--github-repo`；先筛后限 |
| FR-011 | `cancel`：queued/paused 直接取消，running 只登记取消请求，终态拒绝 |
| FR-012 | `logs` 读取 `<stateDir>/logs/<id>.log` 尾部，默认 80 行 |
| FR-013 | 退出码：0 成功、1 任务失败、2 用法/配置、3 找不到、4 不可运行、5 等待超时 |
| FR-014 | `loadConfig` 把相对 `stateDir` 与仓库路径锚定到配置文件目录，保证不同 cwd 指向同一状态 |
| FR-015 | `package.json` 暴露 `bin.pisa`；skill 包位于 `skills/pisa/`，只依赖 shell、`pisa`、`gh` |
| FR-016 | CLI 任务没有对话（`chatId` 为 CLI 标记）：守护进程执行它时不向任何通道发回执，结果由 `wait` / `show` / `logs` 读取 |

## 5. 验收

1. 临时仓库执行 `pisa task "修 CI" --json`，输出任务号，库中任务 `channel=cli`、状态 queued
2. 同一 `--event-id` 执行两次只产生一个任务，第二次返回原任务号
3. `--wait` 在任务被外部置为 succeeded 后返回 0 并输出摘要；失败返回 1；超时返回 5
4. `continue` 生成的新任务 `baseRef` 等于父任务分支，`context` 含父任务号与上一轮请求
5. 未授权仓库、未知命令、未知选项均返回 2，且不写库
6. 心跳新鲜时 `status --json.daemon.alive=true`，否则 false 且 stderr 有警告
7. 从子目录调用时仍使用配置文件同目录的 `.pisa` 状态
8. 现有 128 个测试保持通过；新增 `tests/cli.test.ts` 覆盖上述路径

## 6. 非目标

- 通过网络远程调用 pisa；CLI 只读写本机配置文件与 SQLite
- 替代 webhook / Telegram / GitHub 评论通道
- 自动重启守护进程
- 在 CLI 里执行 Worker 或交付；执行仍由守护进程负责
