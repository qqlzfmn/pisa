# 部署与排障

安装、升级、回滚、常驻与故障处置的唯一入口。配置项完整列表见 [运维手册](./operations.md#完整配置项)，术语见 [领域模型](./domain.md)，内部机制见 [架构文档](./architecture.md)，装好后的日常用法见 [使用说明](./usage.md)。

## 前置条件

| 依赖 | 版本 / 说明 | 检查 |
| --- | --- | --- |
| Bun | 1.4.4（CI 同版本） | `bun --version` |
| git | ≥ 2.28（需要 `git worktree`） | `git --version` |
| gh | 可选，交付时建 PR 才需要 | `command -v gh` |
| omp | 可选，默认 Worker；缺失时任务会失败 | `command -v omp` |

```bash
bun --version
git --version
command -v gh || echo "gh 未安装（可选）"
command -v omp || echo "omp 未安装（可选，worker.adapter 可换）"
```

## 安装

```bash
git clone https://github.com/qqlzfmn/pisa.git
cd pisa
bun install --frozen-lockfile
```

写最小配置。`whitelist.users` 填当前系统用户，Web 入口的默认身份也取它；`repos[].path` 指向任务要修改的仓库，可以是 pisa 自己。

```bash
REPO="$(pwd)"
cat > pisa.config.json <<JSON
{
  "whitelist": { "users": ["$USER"], "repos": ["pisa"] },
  "repos": [{ "alias": "pisa", "path": "$REPO", "baseBranch": "main" }]
}
JSON
```

状态目录默认是仓库下的 `.pisa/`（数据库、日志、工作副本都在这里），`repos[].path` 与它无关。完整字段：

```bash
cp pisa.config.example.json pisa.config.json
```

逐项含义见 [运维手册 · 完整配置项](./operations.md#完整配置项)。

## 启动与自检

前台启动 CLI 通道，日志直接打在终端：

```bash
bun run src/index.ts --channel cli
```

出现下面这行即就绪：

```text
[pisa] ready · channel=cli · repos=pisa · concurrency=2
```

另开一个终端确认守护进程与任务链路：

```bash
bun run src/cli.ts status --json
bun run src/cli.ts task "在 README 末尾加一行 wake up" --wait --timeout 900 --json
```

第二条命令把任务入队后等待结果：`status` 为 `succeeded` 且输出 `branch` 即全链路可用。若未安装 `omp`，任务会以 `failed` 结束，`error` 是找不到可执行文件（ENOENT / Executable not found），不是任务自身的失败。

常驻命令可用 `bun link` 安装为全局 `pisa`，之后把上面的 `bun run src/cli.ts` 换成 `pisa`。不想改全局环境就保持原样。

Web 入口：

```bash
export PISA_WEB_TOKEN="$(openssl rand -hex 16)"
bun run src/index.ts --web
curl -s http://127.0.0.1:8787/health
```

`/health` 不需要 token；`/ui` 与 `/api/*` 需要，浏览器访问 `http://127.0.0.1:8787/ui?token=$PISA_WEB_TOKEN`。

## 常驻（macOS launchd）

```bash
./scripts/install-launchd.sh
launchctl print gui/$(id -u)/ai.pisa.supervisor
tail -f ~/Library/Logs/pisa.launchd.log
```

脚本写入 `~/Library/LaunchAgents/ai.pisa.supervisor.plist`，重复执行会先卸载再装载，等于重装。看护脚本要求 `PISA_TELEGRAM_TOKEN` 存在（即使只开 webhook 或 Web），从环境变量或下面任一文件读取，然后才启动主进程：

```bash
mkdir -p ~/.pisa
printf '%s' "$PISA_TELEGRAM_TOKEN" > ~/.pisa/telegram_token
chmod 600 ~/.pisa/telegram_token
```

`~/.pisa/webhook_token`、`~/.pisa/web_token` 同理。缺少时日志为 `[supervise] 缺少 PISA_TELEGRAM_TOKEN`，退出码 1，launchd 会反复重启。

脚本还会把 `HTTPS_PROXY` 固定写成 `http://127.0.0.1:7897`，`PATH` 固定为 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin`。不需要代理或安装路径不同时，改 `scripts/install-launchd.sh` 后重新安装。

重启与卸载：

```bash
launchctl kickstart -k gui/$(id -u)/ai.pisa.supervisor
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
rm ~/Library/LaunchAgents/ai.pisa.supervisor.plist
```

非 macOS 没有随仓库提供的服务脚本，用本机 init 调用 `scripts/supervise.sh`，或直接以前台方式运行 `bun run src/index.ts`。

## 升级

```bash
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
cp .pisa/pisa.db ".pisa/pisa.db.bak-$(date +%Y%m%d%H%M%S)"
git pull --ff-only
bun install --frozen-lockfile
./scripts/install-launchd.sh
tail -n 50 ~/Library/Logs/pisa.launchd.log
```

前台运行时用 Ctrl-C 停止；主进程收到 SIGINT/SIGTERM 以 75 退出，看护脚本据此重启，未看护时进程就此结束。

数据库不需要手工迁移：启动时 `Store` 构造器建缺失的表并给 `tasks` 补 `session_id`、`base_ref`、`context`、`reply_pr`、`reply_issue`、`reply_repo` 列，再从已有任务回填触发器索引。升级前仍要备份，备份是回滚的唯一凭据。

## 回滚

```bash
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
git switch --detach "$(git rev-parse HEAD@{1})"
bun install --frozen-lockfile
./scripts/install-launchd.sh
```

`HEAD@{1}` 是 `git pull` 之前的位置；先 `git log --oneline -5` 确认目标。回到主线：

```bash
git switch main
git pull --ff-only
```

新版本可能已写入新列或新表，旧代码忽略它们即可。若旧版本在新库上启动失败，停进程后恢复备份：

```bash
cp "$(ls -t .pisa/pisa.db.bak-* | head -1)" .pisa/pisa.db
```

## 排障

先看三处：终端或 `~/Library/Logs/pisa.launchd.log` 的启动日志、`pisa status --json` 里的 `daemon.ageMs`、任务自己的日志。下面命令取最近一个任务的日志：

```bash
bun run src/cli.ts status --json
tail -n 100 ".pisa/logs/$(ls -t .pisa/logs | head -1)"
```

### 启动

| 现象 | 先看 | 处置 |
| --- | --- | --- |
| `[pisa] 缺少环境变量 PISA_TELEGRAM_TOKEN` 后退出 1 | `channels.telegram.enabled` | 设置该变量，或关闭 telegram、改用 `--channel cli` / `--web` |
| `缺少 PISA_WEBHOOK_TOKEN` | `webhook.tokenEnv` 指向的变量 | webhook 不启动但主进程继续；设置 token 后重启 |
| `[pisa] 没有启用的通道` 后退出 1 | `channels.cli` 与 `--web` | 至少开一个入口 |
| `[supervise] 缺少 PISA_TELEGRAM_TOKEN` | `~/.pisa/telegram_token` | 写入 token 文件后 `launchctl kickstart -k …` |
| 无 `ready` 行且进程退出 | 日志最后 20 行 | 配置解析失败、端口占用或未捕获异常；端口用 `lsof -nP -iTCP:8787 -sTCP:LISTEN` 确认 |
| `/health` 返回 503 | 输出里的 `daemon.ageMs` | 心跳超过 10s 即判定未运行；查进程是否存活、事件循环是否被阻塞 |

### 入口与鉴权

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| Web 401 | 未带 token | 加 `?token=…` 或 `Authorization: Bearer …` |
| webhook 403 | `x-pisa-token` 不匹配 | 对照 `webhook.tokenEnv` 的当前值 |
| webhook 400 `eventId must start with webhook:` | eventId 前缀越界 | 用 `webhook:` 开头，或省略让 pisa 生成 |
| webhook 413 | 请求体超过 64 KiB | 缩小载荷，需求正文走任务而不是一次性塞满 |
| webhook 405 | 用了 GET | 只接受 `POST /event` |
| `无权限：该用户不在白名单。` | 身份不在 `whitelist.users` | 加用户；Web 还要让 `web.userId` 命中 |
| `无权限：仓库 X 不在白名单。` | 仓库未授权 | 把别名加进 `whitelist.repos` |
| `仓库未配置：X` | 消息里的 `@别名` 不存在 | 对照 `repos[].alias`；只配一个仓库时省略 `@别名` 走默认 |
| Telegram 无响应 | 群聊未 @ 机器人、token 失效或代理不通 | 私聊直发试一次；查 token 与 `HTTPS_PROXY` |
| GitHub 评论不触发 | 轮询未启用、仓库未登记、评论不以 `/pisa ` 开头或 token 权限不足 | 对照 `github.enabled`、`github.repos`、`trigger` 与 token 权限 |

### 任务执行

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `未知的 Worker 适配器：X（可用：omp）` | `worker.adapter` 拼错 | 改成已注册名称，或按 [扩展指南](./extending.md#加-workeradapter) 注册 |
| `Worker 退出码 127` | Worker 进程找不到命令 | daemon 的 PATH 里没有该命令；launchd 的 PATH 固定为 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin` |
| `执行超时（3600s）` | 超过 `worker.timeoutSec` | 提高超时或拆分任务 |
| `卡死：超过 900 秒没有任何输出或进度` | 超 `idleTimeoutSec` 无输出且进度文件未更新 | 查 agent 是否卡在交互提示；适配器需正确解析输出，skill 需写进度文件 |
| `分支 … 已被其它工作副本占用` | 分支被另一个工作副本占用 | 找到占用任务并取消，清理 `.pisa/worktrees/` 下残留 |
| `提交失败` / `推送失败` | git 身份、远端或凭据问题 | 在仓库根执行 `git status`、`git remote -v`、`gh auth status` |
| `创建 PR 失败` | `gh` 未登录或权限不足 | 修复后由 outbox 重试；失败信息里保留 compare 链接 |
| `仓库路径不是 git 仓库` | `repos[].path` 指错 | 改成含 `.git` 的目录 |
| 重启后任务停在 `paused` | 会话或工作副本仍在，可续跑 | 在 pisa 会话里输入 `/pisa resume <任务号>` |
| 重启后任务变 `failed` | 会话或工作副本已丢失 | 重新派活；先看旧任务日志定位进度 |

### 合并与自举

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `只有原请求者可以合并。` | 操作者不是原请求者 | 由原请求者发起，或用管理员身份 |
| `还有 N 个任务在执行，合并会重启服务并打断它们。` | 合并会重启主进程 | 等执行完，或确认后加 `--force` |
| `任务 X 没有可合并的分支（status）。` | 任务未成功 | 先看任务日志，处理失败或取消 |
| `分支与 main 冲突` | 期间主干已前进 | 基于最新主干重做，再合并 |
| `测试失败` | 验证副本里 `bun test` 未通过 | 按日志修复后重新派活；验证副本已删除 |
| `主工作区当前不在 main` | 主仓库停在其他分支 | 在仓库根执行 `git switch main` 后重试 |
| `已本地合并，但推送 main 失败` | 远端拒绝或网络问题 | 手动 `git push origin main` 补齐 |
| 合并后进程退出 1 | 看护模式下自举重启 | 正常现象；不在看护模式时按提示手动重启 |

## 退出码

### CLI（`pisa` / `bun run src/cli.ts`）

| 退出码 | 名称 | 含义 | 典型命令 |
| --- | --- | --- | --- |
| `0` | `ok` | 成功 | 入队、查询、等待到 `succeeded`、取消或合并已受理 |
| `1` | `taskFailed` | 任务失败 | `task --wait` 等到 `failed` |
| `2` | `usage` | 用法或配置错误 | 未知选项、缺少参数、未知仓库、仓库不是 git、配置无法解析 |
| `3` | `notFound` | 找不到对象 | `show` / `wait` / `cancel` 的任务号不存在，`logs` 无日志 |
| `4` | `notRunnable` | 任务不可运行 | `--wait` 遇到 `paused`、`cancelled`、`rewound`；取消已终态任务 |
| `5` | `timeout` | 等待超时 | `--wait` 超过 `--timeout`（默认 1800s） |

`task` 与 `continue` 只要入队成功就返回 0；守护进程不在线时只在 stderr 警告，不加 `--wait` 看不到后续失败。

### 守护进程

| 退出码 | 含义 | 触发 |
| --- | --- | --- |
| `0` | 自然结束 | 未收到信号、事件循环自行排空；看护脚本看到 0 后不再拉起 |
| `1` | 启动失败或主动退出 | 缺少必需 token、没有启用任何通道、自举合并后主动退出 |
| `75` | 请求重启 | 收到 SIGINT / SIGTERM；看护脚本据此重启 |

### HTTP

| 状态码 | 含义 |
| --- | --- |
| `200` | 成功；`/health` 表示心跳在 10s 内 |
| `400` | 请求体非法、缺 `prompt`、eventId 前缀不符、合并未带 `confirm` |
| `401` | Web 缺 token 或 token 错误 |
| `403` | webhook token 不匹配 |
| `404` | 任务号不存在 |
| `405` | 方法不允许 |
| `409` | 操作已受理但尚未完成（如合并排队、取消请求已登记） |
| `413` | webhook 请求体超过 64 KiB |
| `503` | `/health` 判定守护进程未运行（心跳过期） |

## 上线自检

- [ ] `bun test` 与 `bunx tsc --noEmit` 通过
- [ ] `bun run src/cli.ts status --json` 的 `daemon.alive` 为 `true`
- [ ] 派一条只改文档的任务，`status` 到 `succeeded` 且生成 `branch`
- [ ] `curl -s http://127.0.0.1:8787/health` 返回 200 且 `ok` 为 `true`
- [ ] `~/Library/Logs/pisa.launchd.log` 没有 `[supervise]` 之外的重复报错
