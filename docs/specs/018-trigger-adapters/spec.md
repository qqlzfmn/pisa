# 通用 Trigger 适配层（GitHub Actions / 飞书 / 企业微信）

状态：已实现（见 `tasks.md`）
关联：`017-trigger-thread`（去重身份）、`docs/architecture.md` §4.2、`src/trigger.ts`

## 1. 问题

入口只有 IM、webhook 和 GitHub 评论轮询，真实事件接不进来。

证据（本机复现，`.repro/pisa.config.json` 起 daemon 后探针）：

| 请求 | 现状 |
| --- | --- |
| 真实 GitHub Actions 回调（`x-github-event: workflow_run` + `x-hub-signature-256`，body 为 Actions 载荷） | `403 forbidden` |
| 同上补 `x-pisa-token` | `400 prompt required` |

webhook 入口（`src/index.ts` 内联）只接受 `{prompt}` 形态加共享 token，没有 HMAC 验签；`src/github-watcher.ts` 只轮询 Issue/PR 评论；`src/proactive.ts` 只有群关键词与定时探针。每个新平台都要另写一个 HTTP 服务和一套签名逻辑，平台事件也无法直接变成任务。

## 2. 目标

1. 用统一接口描述「平台回调 → 任务」的三个必要环节：验签、归一化、去重键。
2. 落地 GitHub Actions（HMAC 验签）与飞书 / 企业微信（各自签名 + 加密）三类入口。
3. 入口必须可配置启停，带仓库 / 群 / 用户白名单。
4. 适配器可在无网络、无真实凭据下用 fake 请求测试。

## 3. 用户故事

- 作为维护者，CI 失败时我希望自动得到一次分诊任务，而不是让 CI 脚本自己拼 webhook。
- 作为值班人，我希望在飞书群或企业微信里被 @ 时能直接派单。
- 作为安全负责人，我希望伪造的回调在验签阶段就被拒绝，且重投不会重复建任务。

## 4. 需求

| 编号 | 需求 |
| --- | --- |
| FR-1 | 定义 `TriggerAdapter` 接口：`verify`（传输层校验与验签，只看原始 body/头/查询串）、`normalize`（归一化为 `TriggerEvent`，或返回忽略 / 拒绝 / 握手）、`dedupeKey`（与 core 的触发器身份同源）。 |
| FR-2 | GitHub Actions：`X-Hub-Signature-256` HMAC-SHA256 常量时间比较；只处理 `workflow_run` 且 `action=completed`、`conclusion=failure`。 |
| FR-3 | 飞书：`X-Lark-Signature` = sha256(timestamp + nonce + encryptKey + body)，时间戳窗口 300s；支持 `encrypt` 字段 AES 解密与 `url_verification` 握手；只处理 `im.message.receive_v1` 的文本消息。 |
| FR-4 | 企业微信：`msg_signature` = sha1(字典序拼接 token/timestamp/nonce/encrypt)；AES-256-CBC 解密并校验 corpid；GET `echostr` 握手返回明文。 |
| FR-5 | 配置：`triggers.port/chatId/userId` 加每适配器 `enabled` 与白名单；白名单为空即全部拒绝；密钥只从环境变量读，缺失时跳过该适配器并报错。 |
| FR-6 | 归一化后的事件交给 `Router.handle`：`channel` 为适配器名，`threadKey/messageKey/version/actor/receivedAt` 取自事件，`text` 未带触发器前缀时自动补 `cfg.trigger`。 |
| FR-7 | 事件响应返回去重键，重复投递由 `store.createTaskFromTrigger` 的触发器身份天然去重。 |

## 5. 验收

| 场景 | 期望 |
| --- | --- |
| 伪造 GitHub Actions 签名 | `401`，不产生任务 |
| 同一 Actions run 投两次 | 只有一个任务，两次响应去重键相同 |
| 载荷缺字段 / 非 JSON | `400` |
| 群不在飞书白名单 | `ignore`，不建任务 |
| 企业微信签名不符 | `401` |
| 企业微信 URL 握手 | `200` 返回解密明文 |
| 未启用适配器访问 `/triggers/<name>` | `404` |

## 6. 非目标

- 不改既有 `webhook` 端点与 Ntfy/企业微信 ChannelAdapter 的契约：webhook 是稳定的对外 API，`ChannelAdapter` 是出站通道，两者与入站触发器职责不同。
- 文件监听：它是本地 watcher（与 `GithubWatcher` 同类），不是 HTTP 回调，塞进 `TriggerAdapter` 会迫使接口兼容两种调用形态；未列入本次验收。
- 飞书 / 企业微信的非文本消息（图片、文件、富文本）。
