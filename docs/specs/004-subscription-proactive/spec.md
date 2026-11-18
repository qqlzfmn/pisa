# 004 · 订阅绑定、主动发现、适配器与交付

- 状态：implemented
- 关联：路线图 P1 订阅绑定、P2 主动发现、P3 交付

## 1. 问题

003 之后，pisa 仍要人带着任务号来续跑；群里出事没人 @ 就不会动；Worker 绑死 omp；分支只在本地。

## 2. 实现

### 2.1 订阅绑定（IM 层）

- 每条发出的任务消息记入 `task_messages(chat_id, message_id, task_id)`
- 用户回复该消息时，`IncomingMessage.replyToMessageId` 命中映射
- Router 把这条回复改写成 `continue <任务号> <正文>`，走原有分支续跑

选择 IM 回复而不是 PR 评论：先解决「讨论在聊天里」的主路径；PR 评论需要远程仓库与 token，留待有远程时再加。

### 2.2 主动发现

- **关键词**：群聊消息命中配置词、且没有触发词时开单；同一群按 `cooldownSec` 限流
- **探针**：定时执行 `bash -lc <command>`，退出码非 0 就开单；同一输出只在冷却后重复提醒

探针是通用的：CI 用 `gh run list`，服务探活用 `curl -f`，磁盘用 `df`。

### 2.3 Worker 适配器

- `WorkerAdapter`：`buildArgs` / `buildEnv` / `parseLine`
- `OmpAdapter` 是唯一实现；`worker.adapter` 选择
- Router 不再知道 omp 的 JSON 结构与参数顺序

### 2.4 交付

- `delivery.push` 打开后 `git push -u origin <branch>`
- 提交前按路径分拣：`.github/workflows/**`、`.github/actions/**`、`.env*`、`*.pem`、`*.key`、`id_*`、`.npmrc`、`.netrc`、`**/secrets*` 用 `git reset` 剔出索引，不进入提交与推送
- `delivery.pr` 打开且远程是 GitHub 且本机有 `gh` 时创建 PR
- 无 PR 时回执里给 compare 链接

## 3. 验收

1. 回复任意任务消息，生成的新任务 `base_ref` 等于上一轮分支
2. 群里发「支付挂了」且配置了关键词 → 自动开单；10 分钟内第二条不再触发
3. 探针命令 `exit 3` → 开单并带上退出码与输出
4. `delivery.push=true` → 裸仓库里能 `rev-parse` 到任务分支
5. 换适配器不需要改 Router
