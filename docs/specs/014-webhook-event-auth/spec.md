# 014 · Webhook 事件命名空间与鉴权

- 状态：implemented
- 关联：003（事件入口）、006（GitHub 评论去重）、009（定时任务占位）
- 依赖：无

## 1. 问题

去重键表 `events` 以 `eventId` 为主键，跨通道共享；webhook 又允许调用方自带任意 `eventId`。Router 在建任务前先占位、后鉴权，于是：

- 一条被拒的投递（非白名单用户、仓库未配置、正文为空）也会永久消耗该 `eventId`，后续合法的同 `eventId` 投递被当成重复事件静默丢弃，没有任何回执。
- 持有 webhook token 的一方可以用 `cron:<job>:<minute>`、`github:comment:<repo>:<id>` 等前缀抢先占位，让定时任务与评论触发失效。

命名空间就是权限边界：每个通道只能占用自己的前缀。

## 2. 目标

- 鉴权与参数校验失败的投递不占用 `eventId`
- webhook 只接受 `webhook:` 命名空间；其它前缀明确拒绝
- token 比较不泄漏长度与内容差异
- 请求体有明确上限

## 3. 用户故事

### US-1 被拒的投递不挤掉合法投递

作为白名单用户，我投递 `eventId=E`；此前同一 `E` 被非白名单用户投递并被拒。我的投递照常建任务并收到「已接单」。

### US-2 webhook 不能压掉其它通道

作为运维，我用 `eventId=cron:morning:2026-11-18T09:00` 调 webhook，拿到 400，且该键没有被占用，定时任务照常触发。

### US-3 异常请求被明确拒绝

作为调用方，token 不对得到 403，请求体超过 64 KiB 得到 413，而不是被静默接受或拖垮进程。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `claimEvent` 移到 `checkAccess` 与 prompt 校验之后、`insertTask` 之前；鉴权或校验失败不占用事件键 |
| FR-002 | webhook 的 `eventId` 必须以 `webhook:` 开头，其它前缀返回 400 且不投递；省略时自动生成 `webhook:<毫秒时间戳>:<随机串>` |
| FR-003 | token 用常量时间比较；长度不等直接 403 |
| FR-004 | `Content-Length` 超过 64 KiB 返回 413；实际读取的字节数超过 64 KiB 同样返回 413 |
| FR-005 | README 与 003 的 `/event` 示例写明 `eventId` 必须以 `webhook:` 开头 |

## 5. 验收

1. 非白名单用户投递 `eventId=E` 收到拒绝；白名单用户投递同一 `E` → 建立任务并回复「已接单」；再投一次同 `E` → 任务数仍为 1
2. `eventId="cron:morning:2026-11-18T09:00"` → 400，且 `events` 表无该键
3. 省略 `eventId` → 回执的 `eventId` 形如 `webhook:<数字>:<串>`，Router 收到同一个值
4. token 错误（等长与不等长）→ 403
5. 请求体 64 KiB + 1 → 413，Router 未被调用

## 6. 非目标

- 不改动其它通道的 `eventId` 生成方式（`telegram:`、`cli:`、`cron:`、`github:comment:`、`proactive:`）
- 不把去重表按通道拆表；前缀即边界
- 不做 webhook 请求签名或重放窗口
