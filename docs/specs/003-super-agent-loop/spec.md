# 003 · 持续闭环：进度、策略、续跑、事件入口

- 状态：implemented
- 关联：P2（事件驱动）+ P3（持久与自愈）+ L1（pi 深度集成）

## 1. 问题

P0/P1 能接活、能并行，但从外面看仍是黑盒：任务跑起来后只有「开始」和「结束」，中途在干什么不知道；约束只能在 Router 侧事后检查；上一轮任务结束，上下文就丢了；只有人发消息才能触发。

## 2. 目标

- 执行过程中能看到正在做什么（工具级）
- 破坏性命令在 agent 内部被拦下，而不是跑完再回滚
- 能接着上一个任务的会话继续做
- 外部系统（CI、监控、脚本）能把任务推进来
- 进程崩溃后自动重启，重启后遗留任务有明确归宿

## 3. 实现

### 3.1 pi 扩展（`extensions/pisa-worker.ts`）

Worker 通过 `omp -e extensions/pisa-worker.ts` 挂载，订阅：

| 事件 | 用途 |
| --- | --- |
| `session_start` | 上报会话 id，写入任务记录 |
| `tool_call` | 上报工具名与参数；命中策略直接 `{ block: true }` |
| `tool_result` | 补充非 bash 工具的完成事件 |
| `agent_end` | 结束标记 |

写出的文件：`.pisa/progress/<taskId>.jsonl`，Router 每 2 秒读取并节流转发到对话。

策略拦截（agent 内部）：

- `git push`
- `git reset --hard`
- `git clean -f`
- `rm -rf /`（`/tmp` 除外）
- `sudo`
- `chmod/chown /etc`

### 3.2 续跑

`/pisa continue <任务号> <新要求>`：

1. 校验原任务存在、请求者一致、有成功提交的分支
2. 建新任务：`base_ref = 上一轮分支`，并把上一轮的请求/结果/分支注入提示词
3. 新任务的工作副本从上一轮分支拉出，因此能看到上一轮的文件改动
4. 不恢复旧的 agent 会话——工作副本是临时的，会话目录会被清理

选择「分支续跑 + 上下文注入」而不是会话恢复：会话绑定的工作目录会在任务结束时删除，恢复必然失败；分支续跑既保留了代码状态，也不依赖 pi 的会话存储格式。

### 3.3 事件入口

`POST http://127.0.0.1:<port>/event`，请求头 `x-pisa-token`：

```json
{ "prompt": "跑一遍测试并修掉失败", "repo": "pisa", "eventId": "webhook:ci:12345" }
```

`eventId` 属于跨通道共享的去重键，webhook 只能占用 `webhook:` 命名空间；省略时自动生成（014）。

任务照常排队，回执发到配置的 Telegram 会话。CI 只要 POST 一次。

### 3.4 自愈

- 启动时把遗留 `running` 任务分流：工作副本与会话都在的转 `paused`，其余标 `failed`（005）
- `scripts/supervise.sh`：进程退出码非 0 时按 1→30 秒退避重启
- 任务级超时与取消沿用 001

## 4. 验收

1. 任务执行中，对话里出现 `🛠 <命令>` / `✏️ <工具>` 进度
2. 让它执行 `git push`，回执出现 `⛔ 拦下一条命令`，且命令未执行
3. `continue` 后新任务复用上一个 session id
4. webhook 投递一个任务，Telegram 收到接单与完成回执
5. `supervise.sh` 被杀后 30 秒内自动重启
