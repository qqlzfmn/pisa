# 部署与排障

这份文档按机器生命周期组织：装一次、升级、回滚、看退出码、按现象排障。配置项、命令细节与功能开关见 [operations.md](./operations.md)；设计取舍见 [architecture.md](./architecture.md)。

## 1. 前置条件

| 依赖 | 要求 | 检查 |
| --- | --- | --- |
| Bun | 1.4.4 及以上 | `bun --version` |
| git | 2.28 及以上 | `git --version` |
| agent CLI | 默认 `omp`，能在仓库目录非交互执行 | `command -v omp` |
| gh | 只在推送 PR、拉 GitHub 评论时需要 | `gh auth status` |

没有 `omp` 时，把 `worker.command` 换成任何接受提示词的 CLI，并按 [extending.md](./extending.md#5-加-workeradapter) 实现适配器；仓库目前只注册了 `omp`。

## 2. 首次安装

```bash
export PISA_HOME="$HOME/pisa"
git clone https://github.com/qqlzfmn/pisa.git "$PISA_HOME"
cd "$PISA_HOME"
bun install --frozen-lockfile
```

最小配置。`whitelist.users` 必须包含派活人，`repos[].path` 必须是 git 仓库根目录：

```bash
cat > pisa.config.json <<JSON
{
  "whitelist": { "users": ["$USER"], "repos": ["pisa"] },
  "repos": [{ "alias": "pisa", "path": "$PISA_HOME", "baseBranch": "main" }]
}
JSON
```

前台启动，确认装配无误：

```bash
bun run src/index.ts --channel cli
```

看到 `[pisa] ready · channel=cli · repos=pisa · concurrency=2` 即启动成功。前台按 Ctrl-C 会以 75 退出，这是主动关停的约定，不是崩溃。

常驻用 launchd（开机自启，退出后自动拉起）：

```bash
./scripts/install-launchd.sh
```

脚本生成 `~/Library/LaunchAgents/ai.pisa.supervisor.plist`，日志写到 `~/Library/Logs/pisa.launchd.log`。plist 里把 `HTTPS_PROXY` 硬编码为 `http://127.0.0.1:7897`；机器上没有这个代理时，先编辑 `scripts/install-launchd.sh` 删掉该键再执行，否则 Telegram 与 GitHub 请求会走一个不存在的代理。token 不写进 plist：`supervise.sh` 启动时从环境变量取，缺省读 `~/.pisa/telegram_token` 与 `~/.pisa/webhook_token`。

检查进程与日志：

```bash
launchctl print gui/$(id -u)/ai.pisa.supervisor
tail -n 50 ~/Library/Logs/pisa.launchd.log
```

## 3. 升级

升级前停服务并备份状态目录。数据库迁移只在启动时补表补列，回滚代码不会自动删列；跨版本回滚需要连状态一起恢复。

```bash
cd "$PISA_HOME"
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
cp -a .pisa ".pisa.bak-$(date +%Y%m%d%H%M%S)"
git pull --ff-only
bun install --frozen-lockfile
bunx tsc --noEmit
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/ai.pisa.supervisor.plist"
```

最后一条 `bunx tsc --noEmit` 是类型闸门，失败就不要启动。非 launchd 部署省掉三条 `launchctl`，改为前台重启：

```bash
cd "$PISA_HOME"
git pull --ff-only
bun install --frozen-lockfile
bunx tsc --noEmit
bun run src/index.ts --channel cli
```

pisa 也能用自己升级自己：给机器人发需求，`/pisa merge <任务号>` 在验证副本跑 `bun test`，通过后合并并退出，由看护拉起新代码。步骤见 [operations.md](./operations.md#自举)。这种方式不经过上面的备份步骤，重要部署仍建议手工升级。

## 4. 回滚

先确定要回到哪个提交：

```bash
cd "$PISA_HOME"
git log --oneline -10
```

切到上一个提交并重装依赖：

```bash
cd "$PISA_HOME"
git switch --detach HEAD~1
bun install --frozen-lockfile
bunx tsc --noEmit
```

如果新版本已经改过数据库、旧代码无法读取，恢复升级前的备份。先停服务，再覆盖状态目录：

```bash
cd "$PISA_HOME"
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
latest_backup=$(ls -dt .pisa.bak-* | head -1)
rm -rf .pisa
cp -a "$latest_backup" .pisa
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/ai.pisa.supervisor.plist"
```

`rm -rf .pisa` 只删状态目录，不碰仓库代码与已有备份。恢复后回到原分支继续开发：

```bash
cd "$PISA_HOME"
git switch main
git pull --ff-only
```

## 5. 退出码

### CLI

`pisa` 命令的退出码供脚本分支，语义不在版本间改动：

| CLI 退出码 | 含义 |
| --- | --- |
| 0 | 成功；`pisa task` 只表示已入队，不代表任务成功 |
| 1 | `pisa wait` 等到任务最终 `failed` 或 `cancelled` |
| 2 | 用法错误、配置无法解析、未预期的命令失败 |
| 3 | 找不到任务 |
| 4 | 任务不可运行（`paused`、`cancelled`、`rewound`） |
| 5 | `pisa wait` 超时，任务仍在执行 |

### 守护进程

| 守护进程退出码 | 触发条件 | 看护行为 |
| --- | --- | --- |
| 0 | 前台进程自然结束，只有直接调用与被看护两种方式交界时出现 | 不重启 |
| 1 | 启动失败：缺 token、没有启用的通道、配置 JSON 非法 | 退避 1→30 秒重启，日志里是具体原因 |
| 75 | 收到 SIGINT/SIGTERM，主动关停 | 重启；遗留 `running` 在下次启动时转 `paused` 或 `failed` |
| 其它非 0 | 未捕获异常或进程被外部杀掉 | 退避重启 |

Worker 进程的退出码不会变成 pisa 的退出码：非零退出只把该任务标成 `failed`，最后 20 行输出进回执。

## 6. 数据目录

`stateDir` 默认是仓库下的 `.pisa`，相对路径以配置文件所在目录为基准：

| 路径 | 内容 | 可否删除 |
| --- | --- | --- |
| `pisa.db` | 任务、触发身份、事件、账本、Outbox、元数据 | 删了等于丢历史，不要删 |
| `worktrees/<任务号>/` | 每个任务的 git 工作副本 | 终态任务可清，运行中不能删 |
| `logs/<任务号>.log` | 该任务的执行日志 | 可清 |
| `progress/<任务号>.jsonl` | 流式进度，续跑与回执用 | 终态任务可清 |
| `audit.log` | Web 控制台写操作的审计日志，超限轮转 | 可清 |

## 7. 排障表

先做三件事：看 `pisa status` 的任务状态与 `error`，看 `~/Library/Logs/pisa.launchd.log` 的最后 50 行，确认 `[pisa] ready` 出现过。然后按原文对表。

| 现象或日志原文 | 判据 | 处理 |
| --- | --- | --- |
| `找不到配置文件：...；可用 --config 指定` | 当前目录与父目录都没有 `pisa.config.json` | `cd` 到仓库根，或 `pisa --config "$PISA_HOME/pisa.config.json" status` |
| `配置里没有仓库，请先设置 repos` | `repos` 为空 | 在配置里加 `{ "alias": "...", "path": "...", "baseBranch": "main" }` |
| `仓库路径不是 git 仓库：...` | 路径不存在或不是仓库根 | `git -C "$PISA_HOME" rev-parse --git-dir` 验证后改 `repos[].path` |
| `无权限：仓库 ... 不在 whitelist.repos` | 任务目标别名不在白名单 | 把别名加进 `whitelist.repos`，重启 |
| `[pisa] 没有启用的通道` | `channels.cli`、Telegram、Web 都没开 | 加 `--channel cli`，或打开 `channels.telegram.enabled` / `web.enabled` |
| `[pisa] 缺少环境变量 PISA_TELEGRAM_TOKEN` | Telegram 开了但 token 为空 | `export PISA_TELEGRAM_TOKEN="..."` 后重启；常驻时写 `~/.pisa/telegram_token` |
| `[pisa] webhook 已启用但缺少 ...` | webhook 开了但 token 环境变量为空 | `export PISA_WEBHOOK_TOKEN="..."`，或关掉 `webhook.enabled` |
| `triggers.<name> 已启用，但 triggers.chatId / triggers.userId 未配置` | 触发入口没有归属身份 | 在 `triggers` 下补 `chatId`、`userId`，且身份在 `whitelist.users` 里 |
| `文件监听路径不存在：...` | `fileWatch.paths[].path` 写错 | 改成绝对路径，或用 `$PISA_HOME` 拼出来 |
| `[pisa] 触发适配层启动失败：...` 且带 `EADDRINUSE` | 端口被占 | 运行 `lsof -nP -iTCP:8790 -sTCP:LISTEN` 找进程，改 `triggers.http.port` 或停掉占用者 |
| `警告：没有检测到运行中的 pisa 守护进程` | 只跑了 `pisa task`，没有常驻进程 | 前台或 launchd 启动 pisa，再投递 |
| `未知的 Worker 适配器：...（可用：omp）` | `worker.adapter` 没注册 | 改回 `omp`，或按 [extending.md](./extending.md#5-加-workeradapter) 注册 |
| `卡死：超过 900 秒没有任何输出或进度` | agent 静默超过 `worker.idleTimeoutSec` | 看任务日志确认卡住的位置；确属推理慢就调大 `idleTimeoutSec`，否则修提示词或拆任务 |
| `执行超时（3600s）` | 超过 `worker.timeoutSec` | 拆小任务，或调大 `timeoutSec` |
| `任务 ... 已暂停，恢复请在 pisa 会话里用 resume <任务号>` | 进程重启或孤儿对账把任务转 `paused` | 在 IM 里发 `/pisa resume <任务号>`；没有会话现场时重新投递 |
| Worker 非零退出，回执里有最后 20 行 | agent 自己失败 | 在 `worktrees/<任务号>/` 手工复跑同一命令；修环境或提示词后重新投递 |
| `推送失败: ...` / `创建 PR 失败: ...` | 远端不可达、权限不足或 `gh` 未登录 | `gh auth status`、`git -C "$PISA_HOME" remote -v`；Outbox 会自动重试，修好后等下一轮 |
| `还有 N 个任务在执行，合并会重启服务并打断它们` | `/pisa merge` 被并发闸门拒绝 | 等任务结束，或确认可打断后加 `--force` |
| `合并失败：...` 且提示冲突 | 任务分支与最新主干冲突 | 在最新主干上重做；不要手工 `--force` 合并 |
| `launchctl print` 找不到服务 | plist 没加载或标签不对 | `ls ~/Library/LaunchAgents/ai.pisa.supervisor.plist` 后重新执行 `./scripts/install-launchd.sh` |
| launchd 日志为空且任务不启动 | 日志路径在外部卷，launchd 无权限写 | 把 `StandardOutPath` 与 `StandardErrorPath` 改到 `~/Library/Logs/` 下，重新安装 |

## 8. 停止与卸载

前台进程用 Ctrl-C。launchd 托管时：

```bash
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
rm ~/Library/LaunchAgents/ai.pisa.supervisor.plist
```

`bootout` 会先发 SIGTERM，进程走主动关停：不再接单，最多等 3 秒让执行器收尾，然后以 75 退出。`KeepAlive` 只对启动后的异常退出生效，`bootout` 之后不会自己回来。
