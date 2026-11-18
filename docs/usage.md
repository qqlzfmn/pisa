# 使用场景与能力边界

安装见 [README](../README.md)，命令与配置见 [operations.md](./operations.md)，可直接粘贴的触发语句见 `/pisa examples`。

## 定位

pisa 是常驻的编码任务执行者：你在 IM、PR 评论、webhook 或定时器里派一个目标，它在独立工作副本里改代码、提交到 `pisa/<任务号>` 分支、回报结果。

它不是聊天机器人：没有「随便问问」的通道，每条消息要么是命令，要么被当成任务建单。
它也不是 CI 执行器：没有容器隔离、没有资源配额、不负责构建产物发布。

## 场景速查

| 场景 | 触发 | 产出 |
| --- | --- | --- |
| 改一处代码 | `/pisa 修复登录超时，补一条回归测试` | 独立分支 + 摘要 + PR/对比链接 |
| 多仓库 | `/pisa @family 把首页文案改成中文` | 落在 `family`，回执写明仓库 |
| 接着上一轮 | `/pisa continue t_xxx 错误提示改成中文`，或直接回复任务消息 | 原分支追加提交，上下文带上一轮摘要 |
| 看进度 | `/pisa status` | 运行中 / 排队 / 最近完成 三段，每行带阶段（在等谁、需要什么） |
| 停掉任务 | `/pisa cancel t_xxx` | 2 秒内收口为「取消」，运行中的任务清理工作副本与自建分支 |
| 撤销副作用 | `/pisa rewind t_xxx` → 加 `--yes` | 关 PR、删分支；已合并用 revert |
| 合入主干 | `/pisa merge t_xxx` | 临时副本跑测试，通过后 `--ff-only` 合并 |
| CI 失败 | `POST /event` 带 `x-pisa-token` | 与 IM 相同的执行链路 |
| 脚本读状态 | `pisa status --json`，或 `curl -H "x-pisa-token: $PISA_WEB_TOKEN" 127.0.0.1:8787/api/state` | 与看板同源的快照，退出码表明是否需重启 |
| PR 内派活 | PR 评论 `/pisa 把错误处理补上` | 接续原分支并更新原 PR |
| 到点自动开单 | `schedules` 里的 cron | 队列与执行链路同 IM |

## 最佳实践

- **写清验收标准**：`修复登录超时` 不如 `登录超时改成 30 分钟，补一条超时回归测试`。Agent 按验收标准决定做到哪一步。
- **一个任务一个目标**：同时要改三处，就发三条或先做一条再 `continue`；混在一条需求里，失败时整条回退。
- **优先 `continue`，不要重开**：续跑复用原分支与上一轮摘要，比新任务多一份上下文；回复那条任务消息等同于续跑。
- **合并前看 diff**：`delivery.push` / `delivery.pr` 关闭时改动只留在本地分支；开启后才有远程分支与 PR。自举合并前先看 `rewind <任务号>` 的预览确认影响面。
- **长任务看 `status`**：排队不是失败；`worker.concurrency` 满了就等。不要因为没秒回就重复派单，重复派单会并行改同一仓库。
- **单英文词先确认**：`/pisa refactor` 会被拦下要求 `confirm`，这是防误触；需求写成一句完整的话。
- **给足超时预算**：`worker.timeoutSec` 默认 3600 秒，超时任务按失败收口，分支保留供排查。
- **外部副作用放在 pisa 之外**：需要调生产 API、发消息、写数据库的任务，把「只改代码、由人执行」写进需求。

## 能力边界

### 无沙箱

Worker 在独立 git worktree 里跑 agent，扩展只拦截少数破坏性命令（`git push`、`git reset --hard`、`git clean -f`、`rm -rf /` 除 `/tmp`、`sudo`、改 `/etc` 权限）。其余命令以当前用户权限直接执行，没有容器或虚拟机隔离，也没有网络限制。只在受信仓库和自己有权限的机器上运行。

### 回滚不完整

`rewind` 只能撤销账本内的副作用：PR、本地与远程分支、工作副本、合并提交。任务执行期间的外部调用（API、消息、数据库、部署）不在账本内，撤销不了。`rewind` 只对终态任务可用，运行中的任务先 `cancel`。PR 状态查不到时保守处理：不删分支、不标记已撤销。

### 单机

任务状态存本地 SQLite（`stateDir/pisa.db`），唯一写入口是守护进程：CLI 与脚本经本机管理接口提交，不直接改库。队列是进程内轮询，工作副本在本地磁盘。没有跨机调度，也没有多副本一致性：同一份状态目录只应有一个 pisa 进程在跑，控制面端口也就只有一份。设备离线期间任务停摆，重启后 `running` 任务转 `paused`，需要 `/pisa resume` 拉回。

### 并发

`worker.concurrency`（默认 2）是进程级上限，所有仓库共享；超出的任务排队。每个任务一个独立工作副本，同一仓库的多任务互不覆盖文件，但共享同一份 git 对象库与 CPU。并发调高只提高吞吐，不隔离资源，机器扛不住时表现为整体变慢或超时。

### 鉴权面

- **IM**：`whitelist.users` 与 `whitelist.repos` 双重白名单，未授权用户不建任务（24 小时内只提示一次）。群里仍需要触发词；私聊可直接说需求。
- **webhook**：只监听 `127.0.0.1`，请求头 `x-pisa-token` 必须等于环境变量里的 token；任务身份固定为配置的 `chatId` / `userId`，所以它也必须进白名单。要从外网调用，自己加反向代理与 TLS。
- **管理接口**：常驻 `127.0.0.1:<web.port>`，`/api/*` 只认请求头（`Authorization: Bearer`、`x-pisa-token`）或 `HttpOnly` cookie，`?token=` 只用于打开 `/ui`，缺凭证一律 401。接口与页面派出的任务归 `web.userId`，token 已认证操作者，所以不再查 `whitelist.users`；`whitelist.repos` 与任务状态机照旧生效。
- **CLI**：`pisa` 是管理接口的客户端，只读配置文件与 `PISA_WEB_TOKEN`。除 `help` 外的命令都需要守护进程在跑，连不上时退出 1；缺 token 退出 3。
- **GitHub**：只处理正文以 `/pisa ` 开头的评论；评论作者不参与鉴权，任务归属由各仓库条目配置的 `chatId` / `userId` 决定。`gh` token 从 `tokenEnv` 指定的环境变量读取。
- **定时、探针、关键词**：都用配置里的身份开单，同样走白名单；触发不了的根因通常是身份不在白名单或缺少 `scheduler` 配置。
- **密钥**：Telegram bot token、webhook token 只从环境变量或 `~/.pisa/` 下的文件读取，不写入配置文件与 launchd plist。

## 消息太多怎么办

默认只发生命周期消息：已接单、开始执行、完成/失败、取消。执行过程（工具调用、中间输出）默认不推送。

- `/pisa verbose on` 打开过程消息，`/pisa verbose off` 关闭
- 启动默认值在 `pisa.config.json` 的 `notifications.progress`（默认 `false`）

## 任务卡住了怎么办

pisa 自己兜底，不需要手工改数据库：

1. **卡死检测**：worker 超过 `worker.idleTimeoutSec`（默认 900 秒）没有任何 stdout 或进度事件，进程被 SIGTERM→SIGKILL，任务转 `failed`，原因写进回执。
2. **孤儿对账**：每 5 秒比对数据库里的 `running` 行与进程内执行器。进程被 kill 但服务没重启时，有会话与工作副本的转 `paused`，其余转 `failed`，不会永久挂着。
3. **取消兜底**：`/pisa cancel <id>` 对没有执行器的 `running` 行直接结束，不会停在“取消中”。
4. **合并门禁**：有任务在跑时 `/pisa merge` 会拒绝并说明原因；确实要打断就加 `--force`。

排查顺序：`/pisa status` 看 `error` → `ps` 看 agent 进程是否还在 → `paused` 用 `/pisa resume <id>`，`failed` 重新投递。日志在 `stateDir/logs/<taskId>.log`。

## 不该交给它

- 开放问答、查资料、闲聊——没有对应入口
- 作为 CI runner 执行构建与发布——没有隔离与资源配额
- 生产变更、发版、需要人工审批的操作——没有审批环节，回滚也不完整
- 跨机器、需要分布式锁或共享队列的任务
- 「自己探索直到有结果」的开放式调研——超时即失败，适合目标明确、可验收的任务
