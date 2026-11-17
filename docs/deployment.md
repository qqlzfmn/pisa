# 部署与排障

以下命令都从仓库根目录执行。命令中的绝对路径、token 和仓库名需要替换成实际值。

相关文档：[架构](./architecture.md) · [领域模型](./domain.md) · [扩展指南](./extending.md)

## 前提

| 依赖 | 用途 | 本次验证版本 | 检查命令 |
| --- | --- | --- | --- |
| Bun | 运行时、测试、SQLite | 1.4.4 | `bun --version` |
| git | worktree、提交、合并、撤销 | 2.54.0 | `git --version` |
| omp | 默认 Worker | 18.15.0 | `omp --version` |
| gh | PR、Issue/PR 评论 | 2.103.3 | `gh --version` |
| sqlite3 | 排障与备份（可选） | 3.54.0 | `sqlite3 --version` |
| jq | 查看配置（可选） | 1.8.2 | `jq --version` |

`gh` 只在启用 PR 创建或 GitHub 评论时必需。Worker 命令可以用 `worker.command` 换成别的可执行文件，但必须同时有对应适配器，见[扩展指南](./extending.md)。

## 安装

```bash
bun install --frozen-lockfile --ignore-scripts
cp pisa.config.example.json pisa.config.json
```

编辑 `pisa.config.json`，至少配置一个仓库。最小可用配置：

```json
{
  "repos": [
    {
      "alias": "pisa",
      "path": "/absolute/path/to/pisa",
      "baseBranch": "main"
    }
  ],
  "channels": {
    "cli": true
  }
}
```

其余字段由 [`src/config.ts`](../src/config.ts) 的 `DEFAULT_CONFIG` 补齐。

### 配置合并规则

- 顶层字段整体覆盖；`whitelist`、`worker`、`delivery`、`channels` 做一层合并。
- `channels.telegram` 是整体替换。写了这个对象就必须同时写 `enabled` 和 `tokenEnv`，否则默认值丢失。
- 环境变量 `PISA_TRIGGER`、`PISA_USERS`、`PISA_STATE_DIR` 在读取配置后覆盖对应字段。

### Telegram

1. 在 BotFather 创建机器人，拿到 token。
2. 把 token 写入文件，避免出现在 shell 历史和 plist 里：

```bash
mkdir -p "$HOME/.pisa"
read -rsp "Telegram bot token: " PISA_TELEGRAM_TOKEN
printf '%s\n' "$PISA_TELEGRAM_TOKEN" > "$HOME/.pisa/telegram_token"
chmod 600 "$HOME/.pisa/telegram_token"
unset PISA_TELEGRAM_TOKEN
```

3. 在 `pisa.config.json` 中启用：

```json
{
  "channels": {
    "cli": false,
    "telegram": {
      "enabled": true,
      "tokenEnv": "PISA_TELEGRAM_TOKEN"
    }
  }
}
```

直接运行 `bun run src/index.ts` 时，程序只读环境变量，不读 `~/.pisa/telegram_token`。先导出：

```bash
export PISA_TELEGRAM_TOKEN="$(cat "$HOME/.pisa/telegram_token")"
```

看护脚本 `scripts/supervise.sh` 会自动读取该文件。注意：看护脚本无条件要求 `PISA_TELEGRAM_TOKEN`，即使配置里关闭了 Telegram；用 launchd 时常驻前必须先准备这个文件或环境变量。

### Webhook

```json
{
  "webhook": {
    "enabled": true,
    "port": 8799,
    "tokenEnv": "PISA_WEBHOOK_TOKEN",
    "chatId": "ops",
    "userId": "ci"
  }
}
```

token 同样建议放文件：

```bash
read -rsp "Webhook token: " PISA_WEBHOOK_TOKEN
printf '%s\n' "$PISA_WEBHOOK_TOKEN" > "$HOME/.pisa/webhook_token"
chmod 600 "$HOME/.pisa/webhook_token"
unset PISA_WEBHOOK_TOKEN
```

调用：

```bash
curl -X POST http://127.0.0.1:8799/event \
  -H "x-pisa-token: $PISA_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"跑测试并修掉失败","eventId":"ci:12345"}'
```

只接受 `POST /event`；token 不匹配返回 403，JSON 非法或缺少 `prompt` 返回 400。`eventId` 建议由调用方提供；不提供时服务端生成一次性 id。

### GitHub 评论

```json
{
  "github": {
    "enabled": true,
    "intervalSec": 120,
    "tokenEnv": "GH_TOKEN",
    "repos": [
      {
        "repo": "owner/name",
        "chatId": "telegram-chat-id",
        "userId": "telegram-user-id"
      }
    ]
  }
}
```

`tokenEnv` 指向的环境变量存在时会复制到 `GH_TOKEN`；不存在时由 `gh` 使用自己的登录状态。先确认：

```bash
gh auth status
```

轮询从进程启动时刻开始，不回放历史评论。每条评论的 `eventId` 固定为 `github:comment:<repo>:<commentId>`，重复轮询不会重复建任务。

## 启动与自检

```bash
bun test
bunx tsc --noEmit
git rev-parse --git-dir
```

CLI 模式不依赖 Telegram，适合先验证配置：

```bash
bun run src/index.ts --channel cli
```

正常时打印：

```
[pisa] ready · channel=cli · repos=pisa · concurrency=2
```

在同一终端输入 `/pisa help` 查看命令。`Ctrl-C` 或 `SIGTERM` 会关闭组件并以 75 退出。

Telegram 模式：

```bash
export PISA_TELEGRAM_TOKEN="$(cat "$HOME/.pisa/telegram_token")"
bun run src/index.ts
```

启动失败时先看退出码和最后一行日志，再查[排障表](#排障表)。

## 常驻（launchd，macOS）

安装脚本把 `scripts/supervise.sh` 注册为 `ai.pisa.supervisor`，登录时启动，异常退出后按 1、2、4……30 秒退避重启。

安装前确认：

```bash
test -f "$HOME/.pisa/telegram_token" && echo ok
grep -n "HTTPS_PROXY" scripts/install-launchd.sh
```

脚本把 `HTTPS_PROXY` 硬编码为 `http://127.0.0.1:7897`。没有本地代理时，先删除 plist 模板里的 `HTTPS_PROXY` 键和它的值，再安装；代理地址不同则改成实际地址。

安装或重装：

```bash
chmod +x scripts/install-launchd.sh scripts/supervise.sh
./scripts/install-launchd.sh
```

查看状态与日志：

```bash
launchctl print "gui/$(id -u)/ai.pisa.supervisor"
tail -n 50 "$HOME/Library/Logs/pisa.launchd.log"
```

重启服务：

```bash
launchctl kickstart -k "gui/$(id -u)/ai.pisa.supervisor"
```

卸载：

```bash
launchctl bootout "gui/$(id -u)/ai.pisa.supervisor"
rm "$HOME/Library/LaunchAgents/ai.pisa.supervisor.plist"
```

`supervise.sh` 的规则：退出码 0 表示正常结束，不再重启；任何非零退出都重启并退避。`merge` 在 `PISA_SUPERVISED=1` 下会主动以 1 退出，让看护进程重启并加载新代码。

## 状态目录

默认 `<仓库>/.pisa`，可用 `stateDir` 或 `PISA_STATE_DIR` 改：

```
.pisa/
├── pisa.db
├── pisa.db-wal
├── pisa.db-shm
├── worktrees/<任务号>/
└── progress/<任务号>.jsonl
```

常用检查：

```bash
ls -la .pisa
sqlite3 -header -column .pisa/pisa.db "select status, count(*) as n from tasks group by status;"
sqlite3 -header -column .pisa/pisa.db "select id, status, repo, substr(prompt, 1, 30) as prompt from tasks order by created_at desc limit 5;"
git worktree list
```

备份数据库（WAL 模式下用 `.backup`，不要直接复制正在写入的 db）：

```bash
mkdir -p "$HOME/pisa-backups"
sqlite3 .pisa/pisa.db ".backup '$HOME/pisa-backups/pisa-$(date +%F-%H%M).db'"
```

清理某个任务的残留 worktree 前，先确认任务不在 `running`：

```bash
sqlite3 -header -column .pisa/pisa.db "select id, status from tasks where id = 't_20260101_abcdef';"
git worktree remove --force .pisa/worktrees/t_20260101_abcdef
```

不要在同一个 `stateDir` 上同时运行两个实例。任务领取依赖单进程调度和 SQLite 原子迁移，没有实例间协调。

## 升级

1. 停掉常驻服务（如果装了）：

```bash
launchctl bootout "gui/$(id -u)/ai.pisa.supervisor"
```

2. 备份数据库：

```bash
sqlite3 .pisa/pisa.db ".backup '$HOME/pisa-backups/pisa-before-upgrade.db'"
```

3. 更新代码并安装依赖：

```bash
git pull --ff-only
bun install --frozen-lockfile --ignore-scripts
```

4. 验证：

```bash
bun test
bunx tsc --noEmit
```

5. 重新安装服务：

```bash
./scripts/install-launchd.sh
```

数据库没有独立迁移命令。进程打开数据库时会 `CREATE TABLE IF NOT EXISTS`，并对旧库补充新增列。升级前仍应备份。

## 退出码

| 退出码 | 场景 | 看护进程行为 |
| --- | --- | --- |
| `0` | 正常结束 | 不重启，看护进程退出 |
| `1` | 启动失败：配置读取、缺少 token、没有启用通道 | 重启并退避 |
| `75` | 收到 `SIGINT` / `SIGTERM`，完成优雅关闭 | 重启并退避 |
| 其他非零 | 未捕获异常或 `merge` 在 `PISA_SUPERVISED=1` 下主动退出 | 重启并退避 |

Worker 子进程的退出码不会成为主进程退出码；它会让对应任务进入 `failed`，错误里记录 `Worker 退出码 <n>` 或最后一段 stderr。

## 排障表

| 现象 | 检查 | 原因与处理 |
| --- | --- | --- |
| 启动即退出 1，日志 `缺少环境变量 X` | `echo "${X:-}"` | 配置里的 `tokenEnv` 没导出。直接运行要 `export`；用看护脚本则确认 `~/.pisa/telegram_token` 或 `~/.pisa/webhook_token` 存在。 |
| 启动即退出 1，日志 `没有启用的通道` | `jq '.channels' pisa.config.json` | `channels.cli` 为 false 且 Telegram 未启用。至少开一个。 |
| Telegram 启动报 `Telegram getUpdates: ...` | `curl "https://api.telegram.org/bot$PISA_TELEGRAM_TOKEN/getMe"` | token 错误、被撤销或网络不通。检查 token 和代理。 |
| 任务回了 `无权限：该用户不在白名单。` | `jq '.whitelist.users' pisa.config.json` | 发起人 id 不在 `whitelist.users`。加 id 后重启。 |
| 任务回了 `仓库未配置：...` | `jq '.repos' pisa.config.json` | 消息里的别名不存在。检查 `@别名` 拼写和 `repos[].alias`。 |
| 任务回了 `无权限：仓库 X 不在白名单。` | `jq '.whitelist.repos' pisa.config.json` | 仓库别名没进 `whitelist.repos`。 |
| 任务回了 `仓库路径不是 git 仓库：...` | `git -C <path> rev-parse --git-dir` | `repos[].path` 写错或目录未初始化。 |
| 一直是 `排队` | `sqlite3 .pisa/pisa.db "select status,count(*) from tasks group by status;"` | 并发已满。等运行中的任务结束，或调大 `worker.concurrency` 后重启。 |
| 失败：`创建工作副本失败（分支 ...）` | `git worktree list`、`git branch --list 'pisa/*'` | 分支或目录冲突。清理残留 worktree 或换任务。 |
| 失败：`分支 ... 已被其它工作副本占用` | `git worktree list` | 同一分支被另一个 worktree 使用。删除不用的 worktree 后重试。 |
| 失败：`执行超时（3600s）` | `jq '.worker.timeoutSec' pisa.config.json` | 任务超过 `worker.timeoutSec`。调大或拆小需求。 |
| 失败：`Worker 退出码 127`，或 stderr 提示找不到命令 | `which omp`、`jq '.worker.command' pisa.config.json` | 命令找不到。launchd 的 PATH 比交互 shell 窄，必要时写绝对路径。 |
| 有改动但没有 PR | `jq '.delivery' pisa.config.json`、`git remote -v`、`gh auth status` | 需要同时满足 `delivery.push=true`、`delivery.pr=true`、远端是 GitHub、`gh` 可用。否则只留本地提交。 |
| 有 PR 但没有推送新提交 | `git -C .pisa/worktrees/<任务号> log --oneline -3` | `delivery.push=false`，或任务复用已有 PR 但推送失败。看任务 `error`。 |
| GitHub 评论不触发任务 | `jq '.github' pisa.config.json`、`gh auth status` | 未启用、未配置 `repos[].chatId/userId`、或轮询间隔未到。轮询只处理启动后的新评论。 |
| 任务完成但 GitHub 没回帖 | `jq '.github.enabled' pisa.config.json` | 回帖只在 GitHub 启用时进行；同一个任务同一条回复有 markdown 标记，不会重复发。 |
| 进程重启后任务 `paused` | `sqlite3 .pisa/pisa.db "select id,status,session_id from tasks where status='paused';"` | 有会话和 worktree 才会暂停。发 `resume <任务号>`；缺 worktree 会失败。 |
| `merge` 回 `主工作区当前不在 main` | `git -C <repo> branch --show-current` | 先切回 `baseBranch` 再合并。合并只做 `--ff-only`。 |
| `rewind` 保留分支或提示 PR 状态未知 | `gh pr view <n> --json state` | PR 状态查不到、分支与他人共享、或副作用已不可撤销。按预览里的提示人工处理。 |
| launchd 服务没起来 | `launchctl print "gui/$(id -u)/ai.pisa.supervisor"`、`tail -n 100 "$HOME/Library/Logs/pisa.launchd.log"` | 看护脚本缺少 token、plist 路径过期、代理不可用。修复后重跑安装脚本。 |
| 改了配置但行为没变 | `ps -o command= -p <pid>` | 配置只在启动时读。重启进程或 `launchctl kickstart -k`。 |
| webhook 返回 403 | `echo "$PISA_WEBHOOK_TOKEN"` | 请求头 `x-pisa-token` 与服务端不一致。 |
| webhook 返回 405 | `curl -i http://127.0.0.1:8799/event` | 只接受 POST。 |
| webhook 连接被拒绝 | `jq '.webhook' pisa.config.json`、`lsof -nP -iTCP:8799 -sTCP:LISTEN` | 未启用、端口不同或进程没启动。token 缺失时主进程继续跑，但 webhook 不可用。 |
| Telegram 连不上但机器能上网 | `echo "$HTTPS_PROXY"`、`grep -n HTTPS_PROXY scripts/install-launchd.sh` | 代理地址错误。直接运行用 `PISA_TELEGRAM_PROXY` 或配置项；launchd 用 plist 里的 `HTTPS_PROXY`。 |

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `PISA_CONFIG` | 配置文件路径，默认 `pisa.config.json`。 |
| `PISA_TRIGGER` | 覆盖触发词。 |
| `PISA_USERS` | 逗号分隔的用户白名单，覆盖配置。 |
| `PISA_STATE_DIR` | 覆盖状态目录。 |
| `PISA_TELEGRAM_PROXY` | Telegram API 代理，作为默认值写入配置。 |
| `PISA_TELEGRAM_TOKEN` | Telegram token；`tokenEnv` 默认指向它。 |
| `PISA_WEBHOOK_TOKEN` | webhook token；配置里的 `tokenEnv` 可改名。 |
| `PISA_SUPERVISED` | 为 `1` 时 `merge` 用退出重启代替提示。 |
| `GH_TOKEN` | `gh` 的 token；配置的 `github.tokenEnv` 存在时复制到这里。 |

token 不要写进 `pisa.config.json` 或 plist。文件权限保持 `600`。
