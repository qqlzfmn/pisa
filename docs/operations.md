# 配置与运维

README 只放 30 秒上手；这份文档是完整的手册：配置项、命令细节、事件入口、撤销、常驻与自维护。

## 目录

- [安装与配置](#安装与配置)
- [命令](#命令)
- [撤销与账本](#撤销与账本)
- [Webhook 事件入口](#webhook-事件入口)
- [Agent CLI 与 skill](#agent-cli-与-skill)
- [Web 控制台](#web-控制台)
- [多仓库](#多仓库)
- [主动发现](#主动发现)
- [定时任务](#定时任务)
- [数据保留](#数据保留)
- [GitHub 评论（PR / Issue）](#github-评论pr--issue)
- [自举](#自举)
- [常驻（launchd）](#常驻launchd)
- [完整配置项](#完整配置项)

## 安装与配置

安装命令在 [README 的 30 秒上手](../README.md#30-秒上手)。这里只说配置怎么定位、怎么生效。

配置文件按以下顺序定位：`--config <路径>` → 环境变量 `PISA_CONFIG` → 从当前目录向上找 `pisa.config.json`。相对 `stateDir` 与仓库路径以配置文件所在目录为基准，从子目录调用也指向同一份状态。

`stateDir` 默认 `.pisa`，里面是数据库、工作副本与任务日志。

Telegram 通道：

```bash
export PISA_TELEGRAM_TOKEN="<bot token>"
# pisa.config.json: "channels": { "telegram": { "enabled": true } }
```

代理走 `channels.telegram.proxy` 或环境变量 `PISA_TELEGRAM_PROXY`。

## 命令

```
/pisa <需求>            接一个任务
/pisa examples          可直接照抄的场景（触发方式 + 预期产出）
/pisa cancel [任务号]   取消
/pisa help              按用途分组的命令帮助

私聊里可以直接说需求，不用加 /pisa；群聊仍需触发词。
/status、/cancel、/help 在私聊可直接用。

/pisa continue <任务号> <新要求>   从上一轮的分支和上下文继续做
/pisa resume <任务号>             恢复被进程重启中断的任务（私聊可用 /resume）
/pisa rewind <任务号>             预览并撤销任务的副作用（私聊可用 /rewind）
/pisa status                     任务看板（私聊可用 /status）
```

场景说明、最佳实践与能力边界（无沙箱、回滚范围、单机、并发、鉴权面）见 [usage.md](./usage.md)。

### 误触保护

- 只有一个 token 且与命令编辑距离 ≤ 2（如 `/pisa stats`）不会建任务，直接回复建议命令
- 其余单英文词（如 `/pisa refactor`）先要求确认，回复 `/pisa confirm` 才建任务，10 分钟内有效
- 中文正文与多词正文照常直接建任务

Telegram 启动时用 `setMyCommands` 注册命令菜单（私聊可直接点选）。

### 看板

`/pisa status` 分三段：

- **运行中**：每行 `任务号 · 仓库 · 已运行 3m12s · 需求前 40 字`
- **排队**：数量 + 最多 5 条 `任务号 · 仓库 · 需求前 40 字`
- **最近完成**：最多 5 条 `状态 · 耗时 · 仓库 · 需求前 30 字 · PR 链接`

末尾一行汇总 `总数 / 成功 / 失败 / 暂停`；某段为空时显示 `(无)`。

### 崩溃恢复

进程重启后，工作副本与会话都还在的 `running` 任务进入 `paused`，可用 `resume` 拉回执行；缺任一条的标记 `failed`。

### 续跑

**回复机器人的任意一条任务消息，等于继续那个任务**，不用记任务号：消息 → 任务映射落库，续跑复用上一轮分支与上下文。

### 进度回传

执行时会实时回传进度（`🛠 命令` / `✏️ 文件`），破坏性命令会在 agent 内部被拦下。

## 撤销与账本

- `/pisa rewind <任务号>` 只读预览：将关闭的 PR、将删除的本地/远程分支、是否已合并、哪些动作不可撤销
- `/pisa rewind <任务号> --yes` 执行；已合并的任务用 `revert` 提交回退，不改写历史
- `gh` 查不到 PR 状态时保留分支、不标记完成，修好后重发
- 任务执行期间的其它外部调用（API、消息、数据库）不在账本内，无法撤销

## Webhook 事件入口

CI、监控、脚本都可以把任务推进来：

```bash
curl -X POST http://127.0.0.1:8799/event \
  -H "x-pisa-token: $PISA_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"跑测试并修掉失败","eventId":"ci:12345"}'
```

执行链路：消息 → 鉴权 → 建任务 → 独立工作副本 → `omp` 执行 → 提交到 `pisa/<任务号>` → 回执。

同一 `eventId` 的重复投递只建一个任务。要让不同入口（CI、监控、聊天）里的同一件事落到同一个任务，带同一个 `threadKey`（业务单号即可）：

```bash
-d '{"prompt":"修掉 CI 失败","eventId":"ci:12345","threadKey":"pull/1287","version":"3"}'
```

同 `threadKey` + `eventId` 再投一次、内容不同视为编辑（任务还在排队就更新需求）；`version` 没有编辑语义时可以不传。

## Agent CLI 与 skill

不想接聊天或 webhook 时，coding agent 可以直接调用一次性 CLI。CLI 只读写 `pisa.config.json` 与同一个 `pisa.db`，执行仍由守护进程负责。

```bash
bun link                 # 把 pisa 命令链到 PATH；也可直接用 bun run src/cli.ts
pisa task "修 CI：test 失败日志见 ci.log" --repo demo --json
pisa wait <任务号> --timeout 900 --json
pisa status --json
pisa show <任务号>
pisa logs <任务号> --tail 100
pisa cancel <任务号>
pisa continue <任务号> "按 PR 评论再改"
```

- `--config` 指定配置文件；缺省读 `PISA_CONFIG`，再缺省从当前目录向上找 `pisa.config.json`
- 相对 `stateDir` 与仓库路径以配置文件目录为基准，从子目录调用也指向同一份状态
- 退出码：`0` 成功、`1` 任务失败、`2` 用法/配置、`3` 找不到、`4` 不可运行、`5` 等待超时
- 提交时若 10 秒内没有守护进程心跳，stderr 会警告；任务仍入队，不会丢

给 agent 的可复用说明在 [`skills/pisa/`](../skills/pisa/)：`SKILL.md` 是入口，`references/` 放命令表、brief 模板、失败模式、能力边界与 3 个可复制场景。把整个目录放进 agent 的 skills 目录即可，不依赖 pisa 专有工具。

## Web 控制台

任务多起来后，看板、日志、派活不必再翻聊天记录。控制台是一个单页 HTML，内联样式与原生脚本，没有前端构建步骤：

```bash
PISA_WEB_TOKEN=<自定义 token> bun run web
# Web 控制台：http://127.0.0.1:8787/ui?token=<token>
```

- 只监听 `127.0.0.1`；`/ui` 与 `/api/*` 都要 token（查询参数、`Authorization: Bearer`、`x-pisa-token`、cookie 任一），缺失或错误一律 401
- 用带 token 的 `/ui` 打开后下发 `HttpOnly` cookie，页面随即把地址栏里的 token 抹掉
- 看板三段：运行中 / 排队 / 最近完成（最多 20 条），可按仓库筛选，5 秒自动刷新
- 任务详情：prompt、状态、耗时、分支、PR、副作用与最后 200 行日志
- 支持派活、取消、合并（浏览器二次确认）与复制任务号
- 没配 `${web.tokenEnv}` 时启动生成一次性 token，只打印到日志，不落盘
- 写操作走同一个 `Router`：白名单、状态机、合并前的验证与快进逻辑与 IM 完全一致

```json
{
  "web": { "enabled": true, "port": 8787, "tokenEnv": "PISA_WEB_TOKEN", "userId": "<telegram user id>" }
}
```

`userId` 是页面派出任务的请求者，必须在 `whitelist.users` 里；不配时取 `PISA_CLI_USER` 或 `$USER`。`chatId` 默认 `"web"`，只用于内部记账。也可以 `bun run src/index.ts --web` 临时开启，`--web` 会忽略 `web.enabled`。

## 多仓库

`repos` 可以写多个仓库，入口用 `@别名` 指定这次任务落在哪个仓库；不带别名时走第一个（默认仓库）。

```json
{
  "trigger": "/pisa",
  "whitelist": { "users": ["<telegram user id>"], "repos": ["pisa", "family"] },
  "repos": [
    { "alias": "pisa", "path": "/absolute/path/to/pisa", "baseBranch": "main" },
    { "alias": "family", "path": "/absolute/path/to/family", "baseBranch": "main" }
  ]
}
```

```
/pisa @family 改一下首页     群聊或带触发词
@family 改一下首页           私聊可以直接说
```

- 别名在 `repos` 里精确匹配；写错时不会被吞掉，任务仍进默认仓库，正文保留原文
- 别名可以放在触发词前：`@family /pisa 改一下首页` 与 `/pisa @family 改一下首页` 等价
- 接单回执写明 `仓库：<别名>`，不用回忆默认仓库是哪个
- 续跑固定在父任务所在仓库，别名不会把续跑带到别的仓库

## 主动发现

两种触发方式，都不需要人 @：

```json
{
  "proactive": {
    "keywords": {
      "enabled": true,
      "words": ["挂了", "报错", "失败"],
      "cooldownSec": 600
    },
    "probe": {
      "enabled": true,
      "command": "gh run list --limit 1 --json conclusion -q '.[0].conclusion' | grep -q success",
      "intervalSec": 300,
      "chatId": "<telegram chat id>",
      "userId": "<telegram user id>",
      "prompt": "CI 有失败，定位并修复"
    }
  }
}
```

- **关键词**：群里出现这些词且没人带触发词，自动开单（同一群有冷却）
- **探针**：定时跑一条命令，退出码非 0 就开单；命令写法自由，CI、探活、磁盘检查都能接

## 定时任务

cron 到点自动开单，链路与 IM 消息相同：排队、独立工作副本、执行、回执。

```json
{
  "scheduler": { "chatId": "<telegram chat id>", "userId": "<telegram user id>" },
  "schedules": [
    { "id": "morning", "cron": "0 9 * * 1-5", "prompt": "检查昨天以来的 CI 失败并修复", "repo": "pisa" },
    { "id": "monthly", "cron": "0 0 1 * *", "prompt": "升级依赖并跑测试", "enabled": false }
  ]
}
```

- cron 为 5 段 `分 时 日 月 周`，按进程本地时区；支持 `*`、`*/n`、逗号列表、区间 `a-b`、区间步长 `a-b/n`，周 `7` 等同周日
- `scheduler` 决定任务挂在谁的会话下，缺省时 `schedules` 不生效
- `enabled: false` 保留配置但不触发；`repo` 省略时走默认仓库
- 每 30 秒检查一次；同一分钟只投一次，进程重启也不会重投
- `id` 重复或 cron 非法的 job 在启动日志告警后跳过，不影响其他 job
- `/pisa schedules`（私聊 `/schedules`）查看 id、cron、仓库与启用状态

## 数据保留

事件去重记录、进度文件、任务日志都会随运行时间增长，按下面的规则回收：

```json
{ "retentionDays": 30 }
```

- `retentionDays` 默认 30；≤ 0 关闭每日清理，回收照常
- 每小时检查一次，启动时立即跑一次；同一本地日期只清理一次，重启不重复
- 清理对象：结束时间早于 `now - retentionDays` 的终态任务（成功 / 失败 / 取消 / 撤销）的 `events` 行与 `.pisa/progress/<任务号>.jsonl`；任务行与账本保留，看板与撤销照常可用
- 不属于任何任务的占位行（cron 每分钟占位等）按写入时间过期；不这样清它们没有任务行可依附，永远涨
- 单个任务日志超过 10 MiB 时轮转为 `<任务号>.log.1`，只保留一代，主文件继续写
- 每周 VACUUM 一次并 checkpoint，数据库文件实际缩小；同一 ISO 周只执行一次

## GitHub 评论（PR / Issue）

评审人和维护者可以直接在 PR / Issue 评论里派活，不用绕回 IM：

```json
{
  "github": {
    "enabled": true,
    "intervalSec": 120,
    "tokenEnv": "GH_TOKEN",
    "repos": [
      { "repo": "owner/pisa", "chatId": "<telegram chat id>", "userId": "<telegram user id>" },
      { "repo": "owner/site", "chatId": "<telegram chat id>", "userId": "<telegram user id>" }
    ]
  }
}
```

- `repos` 里的每个仓库独立轮询、独立增量下界；`intervalSec` 与 `tokenEnv` 仍是全局配置
- 旧的单仓库写法 `repo` + `chatId` + `userId` 继续可用；`repos` 非空时优先，旧字段被忽略
- 某个仓库拉取或类型判定失败只影响它自己：本轮不推进它的下界，其它仓库照常
- 轮询仓库的 Issue 评论（PR 评论走同一个 API），默认 120 秒一轮
- 只认正文（去首尾空白）以 `/pisa ` 开头的评论，其余一律忽略
- 启动时刻作为下界，不回放历史评论；拉取失败不推进下界，下一轮继续
- 同一条评论按「仓库 + 评论 id」去重（事件 id `github:comment:<repo>:<id>`），重启、轮询重叠都只建一个任务
- 编号先判定类型（`gh api repos/<repo>/issues/<n>` 看有没有 `pull_request`）：失败就不投递，该仓库本轮也不推进下界
- PR 上已有成功任务时直接在该任务的分支上继续并更新原 PR（不新开分支、不新建 PR）；任务按仓库匹配，`o/a#7` 与 `o/b#7` 互不干扰。上下文带 PR 号与原评论；没有就按普通任务处理，正文是去掉触发词的部分
- Issue 评论产生的任务从主干开新分支，不继承任何父分支；完成后把摘要回帖到该 Issue
- Issue 来源的任务新建 PR 时，正文追加一行 `Closes #<n>`，合并 PR 后自动关闭 Issue
- 复用分支的任务失败或取消时保留共享分支；任务自己新建的 `pisa/<任务号>` 才会被清理
- 任务成功后把摘要（限 3000 字）回帖到评论所在的仓库；旧任务或没有仓库记录时回退到配置里的单仓库；回帖失败进 outbox 按 2s→60s 退避重试，任务状态不变
- GitHub 评论产生的任务仍落在本地默认仓库：配置里没有 GitHub 仓库到本地别名的映射

`gh` 需要认证：`tokenEnv` 指定的环境变量（默认 `GH_TOKEN`）会被读进 `process.env.GH_TOKEN`，`gh` 只认 `GH_TOKEN` / `GITHUB_TOKEN`。评论作者不参与鉴权，任务归属由各仓库条目的 `chatId` / `userId` 决定（旧写法为顶层字段）。

## 自举

pisa 可以改自己：

1. 给机器人发需求（或从 webhook 投递），Worker 在 `pisa/<任务号>` 分支上改代码
2. `/pisa merge <任务号>`：在临时副本跑 `bun test`，通过后 `--ff-only` 合入 `main`
3. 看护模式（`PISA_SUPERVISED=1`）下进程退出，`scripts/supervise.sh` 拉起新代码

这条链路已经实测：任务改 README → merge → 进程 PID 变化 → 新内容生效。

## 常驻（launchd）

`scripts/supervise.sh` 交给 launchd 托管：开机自启，进程退出后自动拉起。

安装（重复执行等于重装）：

```bash
./scripts/install-launchd.sh
```

脚本生成 `~/Library/LaunchAgents/ai.pisa.supervisor.plist` 并加载，工作目录是仓库根目录，日志写在 `~/Library/Logs/pisa.launchd.log`（外部卷上的路径 launchd 无权限写入）。多份 worktree 同时安装会互相覆盖，只保留一份。

看日志：

```bash
tail -f ~/Library/Logs/pisa.launchd.log
launchctl print gui/$(id -u)/ai.pisa.supervisor    # 状态
```

卸载：

```bash
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
rm ~/Library/LaunchAgents/ai.pisa.supervisor.plist
```

token 不进 plist：`supervise.sh` 启动时从环境变量取，缺省读 `~/.pisa/telegram_token` 与 `~/.pisa/webhook_token`。

## 完整配置项

[`pisa.config.example.json`](../pisa.config.example.json) 是全量示例，含 `worker`、`delivery`、`channels`、`web`、`webhook`、`github`、`scheduler`、`proactive` 与 `retentionDays`。

解析是浅合并：只写要覆盖的键，其余取 `src/config.ts` 里 `DEFAULT_CONFIG` 的默认值。`webhook`、`github`、`scheduler`、`proactive` 没有默认值，缺省即关闭。
