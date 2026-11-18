# 部署与排障

从零装好、升级、出问题时按表处理。配置项全集见 [operations.md](./operations.md#完整配置项)，术语见 [domain.md](./domain.md)，结构见 [architecture.md](./architecture.md)。

## 前置

| 依赖 | 要求 | 为什么 |
| --- | --- | --- |
| Bun | 1.4.4 或更新（CI 固定 1.4.4） | 运行时、测试、`Bun.serve` |
| git | 任意近期版本，支持 worktree | 每个任务一个 `.pisa/worktrees/` 副本 |
| agent CLI | 在 `PATH` 里，默认 `omp`；用 `worker.command` 改 | Worker 子进程就是它 |
| `gh` | 可选，GitHub 评论与 PR 交付要用 | 未认证时 `delivery.pr` 失败 |

## 安装

```bash
git clone https://github.com/qqlzfmn/pisa.git
cd pisa
bun install
```

最小可用配置（把 `path` 换成要被改的仓库；保持为 `$PWD` 则 pisa 改自己）：

```bash
cat > pisa.config.json <<JSON
{
  "repos": [{ "alias": "demo", "path": "$PWD", "baseBranch": "main" }],
  "channels": { "cli": true }
}
JSON
```

前台跑一次，看到 `[pisa] ready · channel=cli · repos=demo · concurrency=2` 即成功：

```bash
bun run src/index.ts --channel cli
```

另开一个终端提交任务，`--wait` 会等到终态并按结果返回退出码：

```bash
bun run src/cli.ts task "把 README 的安装步骤改成三段" --wait
```

把 `pisa` 装成全局命令（可选，之后可省略 `bun run src/cli.ts`）：

```bash
bun link
pisa --help
```

守护进程只认 `PISA_CONFIG` 或从当前目录向上找到的 `pisa.config.json`，不解析 `--config`（那是 CLI 的参数）。守护进程允许没有配置文件，此时全部用默认值且没有仓库；CLI 必须有配置文件（`--config`、`PISA_CONFIG` 或向上查找）。

## 运行方式

| 启动方式 | 命令 | 说明 |
| --- | --- | --- |
| CLI 通道前台 | `bun run src/index.ts --channel cli` | 不连 Telegram；stdin 直接收需求 |
| 按配置选通道 | `bun run src/index.ts` | 依次看 `--channel cli`、`channels.telegram.enabled`、`channels.cli`；都没有但 `web.enabled` 时用 CLI 通道当服务宿主；全没有则退出码 1 |
| Telegram | `PISA_TELEGRAM_TOKEN` + `channels.telegram.enabled=true` | token 也可放 `~/.pisa/telegram_token`（仅 `scripts/supervise.sh` 读取） |
| Web 控制台 | `--web` 或 `web.enabled=true` | 默认 `127.0.0.1:8787`；`/health` 无需 token |
| Webhook | `webhook.enabled=true` | 单独的 `webhook.port`；`/webhook` 走 token |

Telegram 启动示例（用 `read -s` 避免 token 进 shell 历史）：

```bash
read -r -s PISA_TELEGRAM_TOKEN && export PISA_TELEGRAM_TOKEN
bun run src/index.ts
```

Web 控制台启动示例（token 缺失时启动那一刻生成一次性 token 并打印，不落盘）：

```bash
export PISA_WEB_TOKEN=$(openssl rand -hex 16)
bun run src/index.ts --web
curl -s "http://127.0.0.1:8787/api/tasks?token=$PISA_WEB_TOKEN"
```

## 环境变量

| 变量 | 用途 | 缺失时 |
| --- | --- | --- |
| `PISA_CONFIG` | 配置文件路径 | 从当前目录向上找 `pisa.config.json` |
| `PISA_TELEGRAM_TOKEN` | Telegram bot token（配置里的 `tokenEnv` 默认指向它） | 启用 Telegram 时启动失败，退出码 1 |
| `PISA_TELEGRAM_PROXY` | Telegram 代理 | 直连 |
| `PISA_WEBHOOK_TOKEN` | webhook 鉴权 token | 启用 webhook 时该入口不可用 |
| `PISA_WEB_TOKEN` | 控制台 token | 生成一次性 token，只打印 |
| `PISA_CLI_USER` | CLI 请求者名 | `$USER` |
| `PISA_REPO` | `pisa task` 的默认仓库别名 | 配置里的第一个仓库 |
| `GH_TOKEN` | `gh` 与 GitHub 交付、触发器签名验证 | `delivery.pr` 与 GitHub 评论链路失败 |
| `PISA_GH_ACTIONS_SECRET` | GitHub Actions 触发器密钥（`triggers.githubActions.secretEnv`） | 该入口返回 503 |
| `PISA_FEISHU_ENCRYPT_KEY` | 飞书触发器 Encrypt Key | 该入口返回 503 |
| `PISA_WECOM_TOKEN` / `PISA_WECOM_AES_KEY` | 企业微信触发器 token 与 EncodingAESKey | 该入口返回 503 |
| `PISA_SUPERVISED` | 标记进程由 `supervise.sh` 托管 | 不影响功能 |

## 常驻 launchd

```bash
./scripts/install-launchd.sh
launchctl print gui/$(id -u)/ai.pisa.supervisor
tail -f ~/Library/Logs/pisa.launchd.log
```

- label 固定 `ai.pisa.supervisor`；重复执行 `install-launchd.sh` 等于重装
- 工作目录是仓库根；日志写在 `~/Library/Logs/pisa.launchd.log`（外部卷上的路径 launchd 无权限写）
- 多份 worktree 同时安装会互相覆盖，只保留一份
- 卸载：

```bash
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
rm ~/Library/LaunchAgents/ai.pisa.supervisor.plist
```

## 升级与回滚

升级按顺序执行；测试不过就别重启：

```bash
git pull --ff-only
bun install
bun test
bunx tsc --noEmit
launchctl kickstart -k gui/$(id -u)/ai.pisa.supervisor
curl -s http://127.0.0.1:8787/health
```

- 数据库自动迁移：`Store` 打开时用 `PRAGMA table_info` 补列、`backfillTriggers()` 补触发器行、`ALTER TABLE` 加 `sessionId`/`baseRef`/`context`/`replyPr`/`replyIssue`/`replyRepo`。不需要手工 SQL，也不需要清库
- 迁移只增不改：新版本的库，旧版本代码能继续读；回退不用回滚数据
- 回退一个提交并重启：

```bash
git log --oneline -5
git checkout HEAD~1
bun install
launchctl kickstart -k gui/$(id -u)/ai.pisa.supervisor
```

- 前台守护进程收到 SIGINT/SIGTERM 退出码 75；`supervise.sh` 据此拉起。想让看护停止重启，用 `launchctl bootout` 而不是 `kill`

## 退出码

| 码 | 谁退出 | 含义 | 调用方应做 |
| --- | --- | --- | --- |
| `0` | `pisa` CLI | 成功；`task --wait` 时任务 `succeeded` | 继续 |
| `1` | `pisa` CLI / `src/index.ts` | CLI：任务 `failed` 或命令被拒；守护进程：缺 bot token、没有任何启用的通道 | CLI 看 `pisa show`；守护进程看 stderr 首行 |
| `2` | `pisa` CLI | 用法或配置错误：缺配置文件、参数非法、配置解析失败 | `pisa --help`；用 `--config` 指定配置 |
| `3` | `pisa` CLI | 找不到任务 | `pisa list` 取正确任务号 |
| `4` | `pisa` CLI | 任务不可运行：`paused` / `cancelled` / `rewound` | `resume` 恢复，或重新投递 |
| `5` | `pisa` CLI | `wait --timeout` 到期任务仍未到终态 | 加大 `--timeout`，或用 `pisa show` 轮询 |
| `75` | `src/index.ts` | 收到 SIGINT/SIGTERM 正常关停，要求 supervisor 重启 | 无需处理；`supervise.sh` 按 1→30 秒退避拉起 |

被信号强杀（`SIGKILL`、OOM）没有退出码可读；看护进程会直接重启，任务由启动对账改成 `paused` 或 `failed`。

## 排障

| 现象 | 先查 | 处理 |
| --- | --- | --- |
| 启动立刻退出 | stderr 首行：`[pisa] 缺少环境变量`、`[pisa] 没有启用的通道` | 补 token 环境变量；打开 `channels.cli` 或 `channels.telegram` |
| `pisa` 报找不到配置文件（退出码 2） | `pwd`、`--config`、`PISA_CONFIG` | 显式指定配置文件；守护进程本身不需要配置文件 |
| 任务一直 `queued` | `pisa status --json` 的 `daemon.alive`（心跳 10 秒）与 `counts.running` | 心跳过期说明守护进程没跑；`running` 等于 `worker.concurrency` 时就等，或调大并发 |
| 任务一直 `paused` | 是否刚重启过进程 | `resume <任务号>` 继续；`cancel <任务号>` 放弃 |
| 日志末尾 `执行超时` | `worker.timeoutSec`（默认 3600 秒） | 调大；或用 `continue` 拆成更小的任务 |
| 日志末尾 `超过 900 秒没有输出` | `worker.idleTimeoutSec`；agent 是否在等交互输入 | 调大；确认 agent CLI 以非交互模式运行 |
| 失败信息是 `工作副本被占用` 或 git worktree 报错 | `git worktree list`、`.pisa/worktrees/` | `pisa cancel` 后等对账清理；确认没有手工在任务目录里操作 |
| 任务成功但没有 PR | `delivery.pr` 是否为 `true`；回执里的 compare 链接 | 打开 `delivery.pr`；`gh auth status` 确认已登录 |
| 截图/回帖没出现 | `gh auth status`；回复 outbox 重试（2s→60s） | 认证修复后自动补发；手工回帖不会重复 |
| webhook 返回 403 | `PISA_WEBHOOK_TOKEN` 与对端是否一致 | 重新下发 token |
| webhook 返回 413 | 正文超过 64 KiB | 改内容或改传摘要 |
| webhook 返回 400 | `eventId` 没有 `webhook:` 前缀，或缺 `prompt` | 用默认事件号或补前缀 |
| 触发器入口 404 | 对应 `triggers.*.enabled` 是否为 `true` | 打开配置并重启 |
| 触发器入口 503 | 密钥环境变量为空 | 补 `secretEnv`/`tokenEnv` 指向的变量 |
| 触发器入口 403 | 仓库或用户在 `repos`/`chats`/`users` 白名单外 | 加白名单，或清空白名单关闭该限制 |
| 控制台 401 | `PISA_WEB_TOKEN`；请求是否带 `?token=`、`x-pisa-token`、`Authorization: Bearer` 或 cookie | 重开带 token 的链接，服务端会下发 cookie |
| 启动日志 `web.userId=… 不在 whitelist.users` | `web.userId`（默认 `$PISA_CLI_USER` 或 `$USER`）与 `whitelist.users` | 把该用户加进白名单，或把 `web.userId` 改成白名单内的名字；否则控制台派活会被拒 |
| `/health` 返回 503 | 心跳是否过期（守护进程主循环停了但 HTTP 还在） | 看 `~/Library/Logs/pisa.launchd.log`；重启看护项 |
| 敏感文件没进提交 | 回执里的 `blocked` 列表 | 设计如此：改敏感路径需人工处理 |
| 端口被占用 | 8790 触发器、8787 控制台、`webhook.port` | `lsof -nP -iTCP:8790 -sTCP:LISTEN` 找到进程再处理 |
| 磁盘持续涨 | `.pisa/logs/`、`.pisa/worktrees/`、`.pisa/progress/` | 调小 `retentionDays`；单任务日志 10 MiB 轮转只留一代；每周 VACUUM 自动执行 |

看单个任务的日志（先取最近任务的号，再跟日志；库里还没有任务时 `list --json` 输出 `[]`，先投一个任务）：

```bash
ID=$(pisa list --json | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
pisa logs "$ID" --tail 100
tail -f ".pisa/logs/$ID.log"
```

## 数据与备份

`stateDir`（默认 `.pisa/`，相对路径按配置文件所在目录解析）里只有四类东西需要关心：

| 路径 | 内容 | 备份 |
| --- | --- | --- |
| `.pisa/pisa.db` | 任务、事件、触发器、账本、心跳（WAL 模式） | 要 |
| `.pisa/logs/` | 任务原始输出，按 10 MiB 轮转 | 可选 |
| `.pisa/progress/` | 进度 NDJSON，供看板与恢复用 | 可选 |
| `.pisa/worktrees/` | 任务工作副本与旧会话 | 不备份，可重建 |

备份前先停看护，避免复制到写了一半的 WAL：

```bash
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
tar -czf ~/pisa-state-$(date +%Y%m%d).tgz --exclude '.pisa/worktrees/*' .pisa
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.pisa.supervisor.plist
```

恢复即把解出来的 `.pisa/` 放回仓库根再启动；`worktrees` 缺失时进行中的任务会被对账为 `paused` 或 `failed`，不会卡在 `running`。
