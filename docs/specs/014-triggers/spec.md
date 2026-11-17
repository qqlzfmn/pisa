# 014 · 通用 Trigger 适配层

- 状态：implemented
- 关联：seed:triggers「入口只有 IM、webhook 和 GitHub 评论轮询，CI 失败、群里被 @、文件变化接不进来」
- 依赖：无（复用 Router 的事件占位去重与白名单）

## 1. 问题

现有入口只有三类：IM 消息、通用 webhook（自定义 token + 自由 JSON）、GitHub 评论轮询。真实事件源都要求「自带协议」：

- GitHub Actions 完成事件由 GitHub 直接推送，带 HMAC 签名，通用 webhook 无法校验来源，只能让用户自己写脚本转发
- 飞书 / 企业微信的消息回调有自己的签名、URL 校验与事件结构，通用 webhook 也没有归一步骤
- 本地文件变化没有任何入口，只能靠定时探针轮询对比

每个新入口都从头写一遍「校验 → 解析 → 过滤 → 建消息 → 去重」，协议细节散落在装配代码里，重复且容易漏掉签名校验。

## 2. 目标

- 一个统一的适配器契约：校验请求真伪、把协议载荷归一化成待投递消息、给出稳定去重键
- 一个 GitHub Actions 适配器：签名校验 + 只接失败的 workflow run
- 一个飞书适配器：签名校验 + URL 校验握手 + 消息白名单
- 一个文件监听源：路径变化去抖后开单，同一内容不重复开单
- 配置控制启用、监听端口、每个来源的投递身份与白名单；未启用时行为与现在完全一致
- 每个适配器都有不联网的假测试，覆盖签名失败、重复事件、非法载荷

## 3. 用户故事

### US-1 CI 失败自动接单

作为维护者，我把仓库的 workflow_run webhook 指向 pisa，CI 失败后自动开一个任务定位并修复，不需要外部脚本拼接事件。

### US-2 飞书群里被 @ 就能派活

作为团队成员，我在飞书群里 @ 机器人并说「修一下登录超时」，pisa 接单；飞书私聊直接说话也能接单。

### US-3 本地文件变化自动接单

作为维护者，我让 pisa 监听某个配置目录，部署文件一改就开单检查；同一份内容重复写入不会重复开单。

### US-4 伪造与重放被拒绝

作为运维，我知道这个端口暴露在内网：签名不对、时间戳过期的请求一律拒绝，不产生任务。

### US-5 重复投递只处理一次

作为维护者，平台重试、进程重启、同一事件被推两遍，都只产生一个任务。

## 4. 需求

配置（`pisa.config.json`）：

```json
{
  "triggers": {
    "enabled": true,
    "port": 8800,
    "host": "127.0.0.1",
    "githubActions": {
      "enabled": true,
      "secretEnv": "PISA_GH_ACTIONS_SECRET",
      "repo": "pisa",
      "chatId": "<chat id>",
      "userId": "<user id>",
      "repos": ["owner/pisa"],
      "branches": ["main"],
      "conclusions": ["failure"]
    },
    "feishu": {
      "enabled": true,
      "encryptKeyEnv": "PISA_FEISHU_ENCRYPT_KEY",
      "verificationTokenEnv": "PISA_FEISHU_VERIFY_TOKEN",
      "chatId": "<chat id>",
      "userId": "<user id>",
      "repo": "pisa",
      "users": ["ou_xxx"],
      "mentionAsTrigger": true
    },
    "files": {
      "enabled": true,
      "paths": ["/absolute/path/deploy"],
      "repo": "pisa",
      "chatId": "<chat id>",
      "userId": "<user id>",
      "debounceMs": 500
    }
  }
}
```

| ID | 需求 |
| --- | --- |
| FR-001 | `Config.triggers` 可选；`enabled` 为真且至少一个来源启用时才启动监听服务，缺省不改变现有行为；端口缺省 8800，默认只绑 `127.0.0.1` |
| FR-002 | 每个来源独立 `enabled` 与投递身份 `chatId` / `userId`；`repo` 为本地仓库别名，省略走默认仓库 |
| FR-003 | GitHub Actions：只接受 `POST /triggers/github-actions`，用 `X-Hub-Signature-256`（`sha256=<hex>`，HMAC-SHA256 over 原始请求体）校验，密钥取自 `secretEnv`；缺失、格式不对或不匹配一律 403 |
| FR-004 | GitHub Actions：只处理 `x-github-event: workflow_run` 且 `action=completed` 的事件；`conclusion` 必须在 `conclusions`（默认 `["failure"]`）；配置了 `repos` / `branches` 时仓库全名与 `head_branch` 必须命中，否则不产生任务 |
| FR-005 | GitHub Actions：归一化正文包含仓库全名、workflow 名、分支、运行链接、提交 sha 与结论；`prompt` 可覆盖操作指令那一行 |
| FR-006 | 飞书：只接受 `POST /triggers/feishu`；用 `X-Lark-Request-Timestamp` + `X-Lark-Request-Nonce` + `encryptKey` + 原始请求体的 SHA-256 校验 `X-Lark-Signature`；时间戳与当前时刻相差超过 300 秒视为重放并 403 |
| FR-007 | 飞书：`{"type":"url_verification"}` 请求在签名之前应答，返回 `{"challenge": ...}`；配置了 `verificationTokenEnv` 时 body 的 `token` 必须匹配，否则 403 |
| FR-008 | 飞书：只处理 `im.message.receive_v1` 的文本消息，`sender_type=app` 的消息跳过（避免回执触发下一轮）；`chat_type=p2p` 视为私聊（`isDirect`），群消息被 @（`mentions` 非空）且 `mentionAsTrigger` 不为 false 时在正文前补触发词；`users` 非空时发送者 `open_id` 必须命中，否则 403 |
| FR-009 | 文件监听：监听 `paths` 中的文件或目录（目录递归），变化后在 `debounceMs`（默认 500ms）内合并成一条消息；只取文件，路径不存在时告警跳过且不阻断其它路径 |
| FR-010 | 去重键：每个适配器为事件给出稳定键，同一事件重复投递时键不变；键即 `IncomingMessage.eventId`，由 Router 的 `claimEvent` 唯一占位，适配层不再二次占位 |
| FR-011 | GitHub Actions 去重键为 `github-actions:<repo>:<run_id>:<run_attempt>`（重跑 attempt 递增即新事件）；飞书为 `feishu:<event_id>`（缺省回退 `feishu:<message_id>`）；文件为 `files:<路径与内容摘要>`，内容不变则键不变 |
| FR-012 | 非法载荷返回 400 且不产生任务：请求体不是 JSON 对象、缺少协议必需字段（GitHub 的 `repository.full_name` 或 `workflow_run.id`、飞书的 `message_id` / 文本内容 / 发送者 `open_id`） |
| FR-013 | 与业务无关的合法事件返回 200 且不产生任务：GitHub 的 `ping`、其它 event 类型、非 completed、结论不符、仓库或分支不在白名单；飞书的非消息事件、非文本消息、空白正文 |
| FR-014 | 适配器内部的异常只影响该请求，返回 5xx 或 400，不中断服务进程，也不影响其它适配器；投递单条消息失败只告警 |
| FR-015 | 鉴权沿用 Router 白名单：配置的 `userId` 必须在 `whitelist.users`，`repo` 别名必须在 `whitelist.repos`；不满足时任务被拒绝，适配层不做第二套权限 |
| FR-016 | 进程关停时停止 HTTP 监听与文件监听 |
| FR-017 | 请求体上限 256 KiB，超限返回 413；非 `POST` 返回 405，未挂载路径返回 404 |

## 5. 验收

1. 给定 `secretEnv` 指向的密钥 `s`，当请求体 `b` 的 `X-Hub-Signature-256` 为 HMAC-SHA256(s, b) 且事件为失败的 workflow_run，投递一条 `channel=github-actions` 的消息，正文含仓库全名、workflow 名、分支与运行链接
2. 给定签名错误或缺失，返回 403，不产生任务
3. 给定同一 `workflow_run` 两次得到正确签名的投递，Router 只建一个任务
4. 给定 `conclusion=success`、`x-github-event: push`、`ping`、仓库不在 `repos` 或分支不在 `branches`，返回 200 且不产生任务
5. 给定请求体 `{not json` 或缺少 `workflow_run.id`，返回 400 且不产生任务
6. 给定飞书 `url_verification` 请求，返回 `{"challenge":"<原值>"}`；配置了验证 token 而 body token 不符时返回 403
7. 给定飞书签名正确、`event_id=E` 的私聊文本消息，投递一条 `channel=feishu`、`eventId=feishu:E` 的消息，正文为消息文本
8. 给定飞书签名错误、时间戳超过 300 秒、发送者不在 `users` 白名单，返回 403 且不产生任务
9. 给定同一 `event_id` 两次投递，Router 只建一个任务
10. 给定飞书文本内容不是 JSON、缺少 `message_id`、缺少发送者 `open_id`，返回 400 且不产生任务
11. 给定群消息 `mentions` 非空，正文前补触发词；没有 @ 的群消息正文不变
12. 给定被监听目录内写入文件，去抖后投递一条 `channel=files` 的消息；同一内容再次写入，去重键不变
13. 给定监听路径不存在，启动告警并跳过，进程继续服务
14. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 企业微信：与企业微信的回调（AES 解密 + `msg_signature`）留作同一接口的后续适配器；本规格只实现飞书
- 飞书事件的加密模式（`encrypt` 字段）：只支持明文事件 + 签名校验
- 飞书回包：回执仍发到配置的 IM 会话；不回写飞书群
- 出站 webhook（把结果推回飞书群/企业微信机器人）
- GitHub Actions 以外的 GitHub 事件（`push`、`release` 等）
- 文件监听的内容级 diff：只报告路径，不注入文件差异
- 适配器的热加载：配置变更需重启进程
