# 022 · 来源准入与策略版本

- 状态：implemented
- 关联：019（通用触发适配层的白名单）、006（GitHub 评论）、012（误触保护）、005（崩溃恢复与 resume）、015（Web 控制台 token）

## 1. 问题

派活鉴权只有 `checkAccess`：白名单用户 + 白名单仓库 + 目录是 git 仓库。它把「谁能派活」压成一份全局名单，但各入口的真实权限并不相同，也没有地方声明：

- **GitHub 评论不看评论者**：任何能评论的人写 `/pisa ...`，任务就以仓库条目配置的 `userId` 建出来，评论者只被记进 `actor`。
- **群消息不看 @**：飞书、企业微信只要发送者在白名单里，群里随便一句不带触发词的话（经适配器拼上触发词后）也会建单。
- **策略无版本**：规则改完之后，重启前建的任务不知道自己按什么规则放行；`/pisa resume` 也不复核，被降权的人仍能把中断任务拉起来。

复现（2026-11-18，临时脚本直接驱动 `Router` 与 `FeishuAdapter`）：

```ts
const router = new Router({ cfg, store, worker, deliverer, channel });
// 1) 名单外的人通过 github 评论派活
await router.handle({ eventId, channel: "github", chatId: "c1", userId: "u1", actor: "mallory", text: "/pisa 删库" });
store.recentTasks().length; // → 1
// 2) 降权后恢复仍能跑
cfg.whitelist.users = [];
await router.handle({ eventId, channel: "github", chatId: "c1", userId: "u1", text: "/pisa resume t_x" });
store.get("t_x")?.status; // → "running"
// 3) 飞书群里没 @ 机器人也建单
feishu.normalize({ ...payload, event: { message: { chat_type: "group", content: '{"text":"修一下登录页"}' } } }); // → 有 event
```

## 2. 需求

FR-001 策略形态：`policy.sources.<来源>` 包含 `allowed`（允许派活的真实 actor 名单）、`admit`（名单内/外 × 是否 @ 机器人四格，`allow`/`deny`）与 `accept`（`off`/`observe`/`auto`）。已知来源：`cli`、`telegram`、`web`、`webhook`、`github`、`github-actions`、`feishu`、`wecom`、`file-watch`、`cron`、`proactive`；配置里写了别的来源名也计入。

FR-002 缺省不改变既有行为：`allowed` 留空表示不额外限制名单（沿用白名单留空的惯例）；私聊、正文带触发词、系统投递（`isDirect`）视为已 @；默认拒绝的只有「名单内未 @」与「名单外」两格。不配 `policy` 时唯一的行为变化是群聊里没 @ 机器人的消息不再建单。

FR-003 判定位置：`Router` 建任务前、`checkAccess` 之后执行。拒绝不占 `eventId`、不写触发器，回复写明原因与策略版本（沿用同一用户 24h 节流）。`observe` 照常建任务，但 mandate 记下本会拒绝的原因；`off` 一律拒绝。

FR-004 任务记录：`tasks` 表新增 `mandate`（source/actor/listed/mentioned/decision/mode/reason）与 `policy_version`；旧库在构造时补列，JSON 读不出来当无记录。

FR-005 策略版本：对 `whitelist` 与解析后的各来源策略做稳定序列化后取 sha256 前 8 位。名单去重排序，同一份策略换写法算出同一版本；改名单、改任一格或改 accept 都会换版本。

FR-006 恢复前重校验：用任务记录的来源与 actor（无记录时回退 `requester`、视为已 @）按当前策略重判，并重跑 `checkAccess`。任一步失败都拒绝恢复、状态保持 `paused`，回复说明原因与 `旧版本 → 当前版本`。

FR-007 `/pisa policy`：列出每个来源的 accept、名单与四格，附当前版本与未结束任务按版本计数；与 `status` 同类，不要求调用者在白名单里。

FR-008 飞书归一化显式给出 `mentioned`（正文含 `@_user_N`/`@_all`，或 p2p）；企业微信、文件监听等入口本来就是私聊或带触发词，不需要改适配器。

## 3. 非目标

- 不做策略热加载：改配置仍需重启，版本变化通过重启后的新进程体现。
- 不追溯已建任务：策略改版只影响新派活与恢复，看板上的老单保留原版本。
- 不做按仓库的策略矩阵：来源是唯一维度，仓库仍由 `whitelist.repos` 管。
- 不做 GitHub 评论者到 IM 用户的身份映射，`allowed` 直接比评论 login。

## 4. 验收

1. 越权：`github` 名单外的 actor 派活被拒，回复含「不在准入名单」与策略版本，排队任务数为 0。
2. 降权：名单换成别人后 `resume` 被拒，任务仍为 `paused`，回复含 `旧版本 → 当前版本`。
3. 恢复：策略未变时恢复放行；没有 mandate 的旧任务按当前策略重判。
4. 四格与 accept：未 @ 默认拒绝且可放开、`observe` 记录不拦、`off` 全拒，均有测试。
5. `/pisa policy` 输出含版本、来源规则行与未结束任务的版本计数。
6. `bun test`、`bunx tsc --noEmit` 通过。
