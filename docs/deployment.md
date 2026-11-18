# 部署与排障

从零到常驻、升级、排障。命令都在仓库根目录执行。配置项全集见 [operations.md](./operations.md)，术语见 [domain.md](./domain.md)，分层见 [architecture.md](./architecture.md)。

## 1. 环境要求

| 依赖 | 版本 / 说明 | 用途 |
| --- | --- | --- |
| bun | 1.4.4（CI 固定此版本） | 运行时、测试 |
| git | ≥ 2.28 | 任务用 `git worktree`；JSON 输出 |
| gh | 可选 | GitHub 评论派活、PR 自动评审、建 PR |
| omp | 可选 | 默认 `worker.adapter=omp`；换别的 agent 见 [extending.md](./extending.md) |

```bash
bun --version
git --version
gh --version
```

缺 bun 时按 <https://bun.sh> 安装；缺 gh 时用系统包管理器安装，然后 `gh auth login`。

## 2. 安装

```bash
bun install --frozen-lockfile
```

配置有两种起步方式：复制 `pisa.config.example.json` 改，或用下面的最小配置。最小配置要先把两个变量改成你自己的值：

```bash
export PISA_REPO="$HOME/code/demo"
export PISA_USER="$USER"
cat > pisa.config.json <<JSON
{
  "trigger": "/pisa",
  "dmWithoutTrigger": true,
  "whitelist": { "users": ["$PISA_USER"], "repos": ["demo"] },
  "repos": [{ "alias": "demo", "path": "$PISA_REPO", "baseBranch": "main" }],
  "worker": { "adapter": "omp", "command": "omp", "timeoutSec": 3600 },
  "delivery": { "push": false, "pr": false },
  "channels": { "cli": true }
}
JSON
```

配置查找顺序：`--config <path>` → 环境变量 `PISA_CONFIG` → 从当前目录向上找 `pisa.config.json`。

## 3. 启动

交互模式（stdin 一行一条消息，stdout 打回执）：

```bash
bun run src/index.ts --channel cli
```

启动后在终端输入 `/pisa 把 README 的错别字修掉`，回车。`--channel cli` 只用于本机调试：进程随 stdin 关闭而退出，不会常驻，所以不要用管道喂一条消息就退出。

守护进程已在运行时，用 CLI 提交并等待结果：

```bash
bun run src/cli.ts task "把 README 的错别字修掉" --wait
```

常驻前台（看护进程，崩溃指数退避重启）：

```bash
./scripts/supervise.sh
```

`supervise.sh` 要求 `PISA_TELEGRAM_TOKEN` 已设置或位于 `~/.pisa/telegram_token`；只用 CLI 或 Web 时不要用它，直接在进程管理器里跑 `bun run src/index.ts`。

macOS launchd（登录即启，KeepAlive）：

```bash
./scripts/install-launchd.sh
launchctl print gui/$(id -u)/ai.pisa.supervisor
tail -f ~/Library/Logs/pisa.launchd.log
```

Linux systemd（可选）：

```bash
mkdir -p ~/.config/systemd/user ~/.pisa
umask 077
printf 'PISA_TELEGRAM_TOKEN=%s\n' "$PISA_TELEGRAM_TOKEN" > ~/.pisa/env
cat > ~/.config/systemd/user/pisa.service <<UNIT
[Unit]
Description=pisa
After=network.target

[Service]
WorkingDirectory=$(pwd)
EnvironmentFile=%h/.pisa/env
ExecStart=/bin/bash $(pwd)/scripts/supervise.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now pisa
journalctl --user -u pisa -f
```

`EnvironmentFile` 不会解析引号与注释，文件里每行一个 `KEY=value`。

## 4. 验证

```bash
bun run src/cli.ts status
```

启动日志出现 `[pisa] ready · channel=… · repos=… · concurrency=…` 即装配完成。Web 控制台开启时（`web.enabled=true`），启动日志会打印带 token 的 `http://127.0.0.1:8787/ui?token=…`。健康检查不需要鉴权：

```bash
curl -fsS http://127.0.0.1:8787/health
```

`ok` 取守护进程心跳；心跳停止时返回 503，即使端口仍能应答。

## 5. 升级

```bash
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
git pull --ff-only
bun install --frozen-lockfile
bun test
bun run typecheck
./scripts/install-launchd.sh
```

不用 launchd 时把第一条换成停掉自己的进程管理器，最后一条换成重启 `./scripts/supervise.sh`。

重启而不重装：

```bash
launchctl kickstart -k gui/$(id -u)/ai.pisa.supervisor
```

前台运行：`Ctrl-C`。`src/index.ts` 收到 SIGINT/SIGTERM 后依次停 HTTP 服务、在途任务、存储，退出码 75；`supervise.sh` 对非 0 退出码会重启，所以停常驻要先停看护进程（`launchctl bootout` 或 `Ctrl-C` 前台回路），只 `kill` 子进程会被拉起。

自升级（pisa 改自己的代码）：`/pisa merge <任务号>` 把任务分支合进仓库的 `baseBranch`（缺省 `main`）并跑测试，但**不重启进程**；合并后仍需按上面的重启步骤加载新代码。

## 6. 卸载

```bash
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
rm ~/Library/LaunchAgents/ai.pisa.supervisor.plist
```

任务分支与 worktree 要先处理，否则仓库里会留下悬空登记。先看有哪些：

```bash
bun run src/cli.ts list
git -C "$PISA_REPO" worktree list
```

逐个任务 `/pisa rewind <任务号>` 或 `git worktree remove` 清掉工作副本，然后 `git -C "$PISA_REPO" worktree prune`。数据目录 `.pisa/` 与配置 `pisa.config.json` 按需删除；`.pisa/` 里是任务历史、日志、进度与 worktree。

## 7. 端口

| 端口 | 服务 | 配置项 | 监听地址 |
| --- | --- | --- | --- |
| 8787 | Web 控制台与 `/health` | `web.port` | 127.0.0.1 |
| 8790 | 触发适配层 HTTP 入口 | `triggers.http.port` | 127.0.0.1 |
| 8799 | Webhook 事件入口 | `webhook.port` | 127.0.0.1 |

三个服务都只监听本机；外部事件由反向代理或内网转发进来。改端口只改配置，不改代码。

## 8. 数据与备份

| 位置 | 内容 |
| --- | --- |
| `.pisa/pisa.db` | 任务、消息、触发、事件、outbox、账本（SQLite） |
| `.pisa/logs/<任务号>.log` | 单任务 JSON 行日志（10 MiB 轮转到 `.1`） |
| `.pisa/progress/<任务号>.jsonl` | Worker 进度事件 |
| `.pisa/worktrees/<任务号>/` | 任务工作副本 |
| `pisa/<任务号>` 分支 | 任务分支，落在对应仓库里 |

在线备份（WAL 模式不要直接 `cp`）：

```bash
sqlite3 .pisa/pisa.db ".backup '/tmp/pisa-backup.db'"
```

恢复：停进程，删掉 `pisa.db-wal` / `pisa.db-shm`，用备份覆盖 `.pisa/pisa.db`，再启动。

```bash
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
cp /tmp/pisa-backup.db .pisa/pisa.db
rm -f .pisa/pisa.db-wal .pisa/pisa.db-shm
./scripts/install-launchd.sh
```

## 9. 退出码

CLI（`bun run src/cli.ts …`，事实源是 `src/cli.ts` 的 `EXIT` 与 `helpText()`）：

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 任务失败或命令被拒 |
| 2 | 用法/配置错误 |
| 3 | 找不到任务 |
| 4 | 任务不可运行（暂停/取消/撤销） |
| 5 | 等待超时 |

守护进程（`bun run src/index.ts`，看护脚本按此分支）：

| 码 | 含义 | `supervise.sh` 行为 |
| --- | --- | --- |
| 0 | 正常退出 | 不再重启，回路结束 |
| 1 | 启动失败：缺 token 环境变量、没有启用的通道、配置解析失败 | 退避后重启 |
| 75 | 收到 SIGINT/SIGTERM，关停完成 | 退避后重启（停常驻要停看护进程） |
| 其他 | 崩溃 | 退避重启，间隔 1 秒起翻倍，上限 30 秒 |

## 10. 排障

先拿事实：`bun run src/cli.ts status` 看守护进程心跳与队列；`.pisa/logs/<任务号>.log` 看单任务；`bun run src/cli.ts show <任务号>` / `bun run src/cli.ts logs <任务号>` 是从库和日志读的同一份事实。

| 症状 | 先看 | 常见原因 | 处理 |
| --- | --- | --- | --- |
| 启动即退出，`[pisa] 没有启用的通道` | 配置 `channels` / `web.enabled` | 没有任何通道被启用 | 配 `channels.cli` 或启动时加 `--channel cli` |
| 启动即退出，`[pisa] 缺少环境变量 …` | 该环境变量名 | token 没导出，或看护脚本读不到 `~/.pisa/telegram_token` | `export PISA_TELEGRAM_TOKEN=…` 后重启 |
| 启动即退出，`找不到配置文件` | 当前目录 | 不在仓库根，或 `PISA_CONFIG` 指错 | `--config /绝对路径/pisa.config.json` |
| 端口占用 `EADDRINUSE` | `lsof -nP -iTCP:8790 -sTCP:LISTEN` | 旧进程没退，或端口改了别处 | 停掉旧进程或改 `web.port` / `triggers.http.port` / `webhook.port` |
| 任务一直 `queued` | `bun run src/cli.ts status`、`pgrep -fl src/index.ts` | 并发满（`worker.concurrency`）、进程没在跑、Worker 进程卡住 | 等槽位或调大并发；确认守护进程存活；看日志确认 Worker 是否启动 |
| 任务 `paused` | `bun run src/cli.ts show <任务号>` | 进程重启时任务在执行中，按恢复规则转 `paused` | 在原会话发 `/pisa resume <任务号>`（新增需求用 `continue`，它开新任务接续会话） |
| 任务 `failed`，日志有 `执行超时` | 任务日志最后一行 | `worker.timeoutSec`（默认 3600）到点 | 调大超时后 `continue`，或拆小需求 |
| 触发入口 401 | `curl -i` 与平台签名配置 | 密钥不一致或时间窗过期（飞书） | 对齐 `secretEnv` 指向的变量与平台侧密钥 |
| 触发入口 403 | 日志 `不在白名单` | `repos` / `chats` / `users` 白名单未包含来源 | 补齐配置对应白名单 |
| 触发入口 503 | 日志 `缺少 <secretEnv>` | 入口启用但密钥环境变量为空 | 导出密钥后重启；不会退化免签 |
| 触发器完全没起 | 日志 `触发适配层启动失败` | `triggers.chatId` / `triggers.userId` 未配、文件监听路径不存在 | 补齐身份字段；`fileWatch.paths` 用存在的绝对路径 |
| `gh: command not found` / PR 建不出来 | `gh auth status` | 未安装或未登录；多仓库时缺权限 | 安装并 `gh auth login`；交付会退回 `compare` 链接，任务终态不变 |
| `SQLITE_BUSY` / locked | `pgrep -fl src/index.ts` | 同时跑了两个 pisa 进程指向同一 `.pisa/` | 只保留一个进程；必要时 `bun run src/cli.ts status` 确认心跳 |
| launchd 没拉起 | `launchctl print gui/$(id -u)/ai.pisa.supervisor` | plist 未 bootstrap、路径过期、`omp`/`gh` 不在 PATH | 重新 `./scripts/install-launchd.sh`；plist 的 PATH 需包含 `~/.bun/bin` |
| 交付没推送，回执列了路径 | 回执「未提交」一行 | 命中敏感路径拦截（`.env*`、`*.pem`、`.github/workflows/**` 等） | 手工处理这些文件；pisa 不会替你提交 |
| 撤销后仍有残留 | `bun run src/cli.ts show <任务号>` 的账本 | 已合并的远端历史不可改写；`gh` 查询失败时跳过 | 按回执列出的不可逆项手工处理；`reconcile` 查看 `unknown` 项 |
| 看板阶段与预期不符 | `bun run src/cli.ts show <任务号>` 的 `stage` | `stage` 由 `status`、`branch`、`prUrl` 派生 | 看 `status` 与分支是否存在，不要改 stage |

## 11. 日志

```bash
tail -n 200 ~/Library/Logs/pisa.launchd.log
bun run src/cli.ts logs <任务号>
```

日志里的 token、密钥、`ghp_*`、`sk-*` 在写入前按正则脱敏；任务日志按 10 MiB 轮转到 `<任务号>.log.1`。
