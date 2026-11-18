# 部署与排障

装在哪儿、升级注意什么、出问题看哪里。架构与数据流见 [architecture.md](./architecture.md)，术语见 [domain.md](./domain.md)，加来源与适配器见 [extending.md](./extending.md)；命令与配置项全集见 [operations.md](./operations.md)。

## 安装

### 前置

| 依赖 | 要求 | 检查 |
| --- | --- | --- |
| Bun | 1.4.4 及以上 | `bun --version` |
| git | 2.5 及以上（worktree） | `git --version` |
| agent CLI | 在 `PATH` 里且已登录；默认 `omp` | `command -v omp` |
| gh | 可选；建 PR、评论轮询需要 | `command -v gh` |

Bun 缺失时：

```bash
curl -fsSL https://bun.sh/install | bash
```

### 克隆、装依赖、建配置

```bash
git clone https://github.com/qqlzfmn/pisa.git && cd pisa
bun install --ignore-scripts
cp pisa.config.example.json pisa.config.json
```

`--ignore-scripts` 不跑依赖的生命周期脚本。`pisa.config.json` 里至少要改 `repos[].path`（指向真实仓库的绝对路径）和要开的通道；完整字段见 [operations.md](./operations.md) 的配置项表。

### 冒烟启动

```bash
bun run src/index.ts --channel cli
```

`--channel cli` 跳过通道配置直接起 CLI 通道，用来验证依赖与配置能被读取。预期输出形如：

```text
[pisa] ready · channel=cli · repos=pisa · concurrency=2
```

看到这行就说明依赖、配置、数据库都通了；`Ctrl-C` 结束即可。CLI 通道启动期间信号处理器还没注册，退出码是默认的 `130`，不是 `75`——常驻用下一节的 launchd。

### 装成 `pisa` 命令（可选）

```bash
bun link
pisa --help
```

### 常驻（macOS launchd）

看护脚本 `scripts/supervise.sh` 在进程非 0 退出时退避重启，退出码 `0` 时停止重启。`scripts/install-launchd.sh` 负责生成并加载 launchd 任务。

token 不进 plist：直接放环境变量，或写在 `~/.pisa/telegram_token`、`~/.pisa/webhook_token`、`~/.pisa/web_token` 里由看护脚本读入。先备好 token 再装，否则看护脚本会立刻因缺少 token 退出并进入退避：

```bash
echo "$PISA_TELEGRAM_TOKEN" > ~/.pisa/telegram_token
chmod 600 ~/.pisa/telegram_token
```

装载并跟踪日志：

```bash
./scripts/install-launchd.sh
tail -f ~/Library/Logs/pisa.launchd.log
```

查看与手动重启：

```bash
launchctl print gui/$(id -u)/ai.pisa.supervisor
launchctl kickstart -k gui/$(id -u)/ai.pisa.supervisor
```

同一份状态目录只跑一个守护进程；第二个实例会和第一个抢端口与 SQLite 写锁。`pisa status` 会打印 `守护进程：运行中（最后心跳 …）` 或 `未运行`。

非 macOS 没有现成安装脚本，用 systemd 或 supervisor 调 `scripts/supervise.sh` 即可；重启语义由脚本自身保证。

### 卸载

```bash
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
rm ~/Library/LaunchAgents/ai.pisa.supervisor.plist
```

状态目录（数据库、日志、进度、工作副本）不会自动删除；确认不再需要后手动删 `.pisa/`。里面有已推送分支与 PR 的撤销依据，删除后只能手工处理远端。

## 升级

```bash
cd pisa
git pull --ff-only
bun install --ignore-scripts
bun test
bunx tsc --noEmit
```

测试与类型检查通过后再重启守护进程：

```bash
launchctl kickstart -k gui/$(id -u)/ai.pisa.supervisor
```

没装 launchd 时，让看护脚本收到退出即可：`pkill -f 'bun run src/index.ts'`，看护脚本会拉起新代码。

### 数据库

不需要手动迁移。`Store` 启动时执行 `CREATE TABLE IF NOT EXISTS`，再按 `PRAGMA table_info(tasks)` 给缺的列补 `ALTER TABLE ... ADD COLUMN`（`session_id`、`base_ref`、`context`、`reply_pr`、`reply_issue`、`reply_repo`）。库在 `.pisa/pisa.db`，WAL 模式，同目录还会有 `-wal`、`-shm`。

升级前备份：

```bash
mkdir -p .pisa/backup
sqlite3 .pisa/pisa.db ".backup '.pisa/backup/pisa-$(date +%F).db'"
```

只补列不删列，所以新库结构对旧代码通常可读；但这是推断而非保证，回滚代码前先备份。

### 回滚边界

| 已发生的事 | 能不能回滚 | 怎么做 |
| --- | --- | --- |
| 进程代码 | 能 | 切回上一个提交并重启；数据库先备份 |
| 已合并到主干 | 部分 | 主干只追加，用 `git revert <merge 提交>` 抵消 |
| 已推送分支 / PR | 部分 | `/pisa rewind <任务号>` 做预览，确认后加 `--yes` 关闭 PR、删分支 |
| 已发出的消息、PR 评论 | 不能 | 外部系统的历史无法撤回，只能补发说明 |

升级后重启时，`running` 的任务按「有会话 id 且工作副本还在」分流：是则转 `paused`，否则转 `failed`，启动日志会报 `[pisa] 中断任务：N 个可恢复（paused）`。

## 排障

### 先看这三处

下面的任务号是示例，换成 `pisa list` 里看到的真实 id。

| 想知道 | 命令 |
| --- | --- |
| 守护进程活着吗、队列多长 | `pisa status` |
| 某个任务到哪一步、为什么停 | `pisa show t_20261118_ab12cd` |
| 任务日志最后几十行 | `pisa logs t_20261118_ab12cd --tail 50` |

日志是 `.pisa/logs/<任务号>.log` 的 JSON 行（`ts`、`stage`、`msg`），超过 10MB 轮转出一代 `.1`。进度是 `.pisa/progress/<任务号>.jsonl`。

### 排障表

| 现象 | 先查 | 处理 | 依据 |
| --- | --- | --- | --- |
| 提交后一直 `queued`，CLI 提示 `没有检测到运行中的 pisa 守护进程` | `pisa status` 的心跳与 `launchctl print gui/$(id -u)/ai.pisa.supervisor` | 起守护进程；launchd 未加载就重跑 `./scripts/install-launchd.sh` | `src/cli.ts` |
| 启动即退，日志 `[pisa] 缺少环境变量 PISA_TELEGRAM_TOKEN` | `echo ${PISA_TELEGRAM_TOKEN:+set}` | 导出 token，或把 `channels.telegram.enabled` 设为 `false`、改用 `channels.cli` | `src/index.ts` |
| 启动即退，日志 `[pisa] 没有启用的通道` | 配置里的 `channels` 段 | 开 `channels.cli`、`channels.telegram` 或 `web.enabled` | `src/index.ts` |
| 启动即退，日志 `[pisa] 注册命令菜单失败：…` | 只有这一行时进程仍在跑 | 忽略；命令菜单注册失败不阻断启动 | `src/index.ts` |
| `pisa task` 报找不到配置文件（退出码 2） | 当前目录向上是否有 `pisa.config.json` | `--config <路径>` 或设 `PISA_CONFIG` | `src/cli.ts` |
| 任务 `failed`，error `卡死：超过 900 秒没有任何输出或进度` | 日志尾部、`ps` 里 agent 是否还在 | agent 在等交互就加 `--yolo` 类参数；长任务调 `worker.idleTimeoutSec` | `src/worker.ts` |
| 任务 `failed`，error `执行超时（3600s）` | 任务规模 | 拆小需求，或调 `worker.timeoutSec` | `src/worker.ts` |
| 任务失败但 error 是模型认证或网络错误 | `[pisa] Worker 环境白名单 · …` 里有没有对应变量 | 把变量名加进 `worker.envAllow`；只在启动时读取 | `src/config.ts` |
| 回执给的是 compare 链接、没有 PR | `pisa show` 的交付结果、`gh auth status` | 打开 `delivery.pr`；装好并认证 `gh` | `src/deliver.ts` |
| 推送或回帖失败 | 日志里的 `outbox` 行 | 自动按 2s→60s 退避重试，最多 10 次；`gh` 认证修好后会补发 | `src/effects.ts` |
| 重启后任务变 `paused` | 启动日志 `[pisa] 中断任务：N 个可恢复（paused）` | 在会话里发 `/pisa resume <任务号>`，或 `/pisa cancel <任务号>` | `src/router.ts` |
| 启动报端口占用 `EADDRINUSE`（Web 默认 8787；webhook 看配置里的 `webhook.port`，示例用 8799） | `lsof -nP -iTCP:8787 -sTCP:LISTEN` | 停掉旧进程，或改 `web.port` / `webhook.port` | `src/config.ts` |
| `schedules` 里没有定时任务 | 启动日志的定时段 | 检查 `schedules` 配置；不在窗口内的补跑不会发生 | `src/scheduler.ts` |
| GitHub 评论没收到 | `pisa show`、`gh auth status`、`github.repos` | 配 `github.tokenEnv` 指向的 token（会转交为 `GH_TOKEN`），只轮询 `github.repos` 里的仓库 | `src/github-watcher.ts` |
| 任务长期 `running`，日志不涨 | `.pisa/progress/<任务号>.jsonl` 的 mtime | 卡死检测会在静止 900 秒后杀进程；急停用 `pisa cancel <任务号>` | `src/worker.ts` |

### 退出码

| 进程 | 退出码 | 含义 | 代码位置 |
| --- | --- | --- | --- |
| `pisa` CLI | `0` | 成功；事件已存在时返回原任务也算成功 | `src/cli.ts` |
| `pisa` CLI | `1` | 任务失败（`wait` 结束时任务为 `failed`） | `src/cli.ts` |
| `pisa` CLI | `2` | 用法或配置错误：未知选项、找不到配置、非法状态 | `src/cli.ts` |
| `pisa` CLI | `3` | 找不到任务 | `src/cli.ts` |
| `pisa` CLI | `4` | 任务不可运行：暂停、已取消、已撤销 | `src/cli.ts` |
| `pisa` CLI | `5` | `wait` 等待超时 | `src/cli.ts` |
| `守护进程` | `0` | 进程正常返回；常驻循环不会自行走到这里，看护脚本见到 `0` 即停止重启 | `src/index.ts` |
| `守护进程` | `1` | 启动失败：缺 token、没有启用的通道 | `src/index.ts` |
| `守护进程` | `75` | 信号处理器已注册时收到 SIGINT/SIGTERM，完成关停；看护脚本据此重启 | `src/index.ts` |
| `守护进程` | `130` | 通道启动尚未返回时收到 Ctrl-C，处理器还没注册，交给默认信号行为 | `src/index.ts` |
| `Worker` 子进程 | `0` | 任务成功 | `src/worker.ts` |
| `Worker` 子进程 | 非 0 | 任务失败；stderr/stdout 最后 20 行进 `error`（已脱敏） | `src/worker.ts` |
