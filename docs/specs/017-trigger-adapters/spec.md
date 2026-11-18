# 017 · 通用 Trigger 适配层

- 状态：implemented
- 关联：003（事件入口）、011（GitHub 多仓库）、`src/github-watcher.ts` 只轮询评论
- 依赖：Router 的事件去重（`Store.claimEvent`）与白名单（`whitelist.users`）

## 1. 问题

真实事件进不来，只能人工转述或写外部胶水：

- GitHub Actions 失败：`github-watcher` 只读 Issue / PR 评论；`proactive.probe` 只能定时跑一条命令。要接 CI 失败，得自己写脚本拼 `POST /event` 和一个长期 token。
- 群里被 @：只有 Telegram 通道能收消息；飞书、企业微信群里的求助不会变成任务。
- 现有 `/event` 入口只有一个固定 `x-pisa-token`，没有按来源校验签名、没有事件级去重键，也不认识各平台的载荷格式。

## 2. 目标

- 用统一接口描述「外部事件 → 任务」：来源校验、载荷归一化、稳定去重键三段分离
- 同一套 HTTP 外壳挂多个来源，新增来源只加适配器，不改 Router
- GitHub Actions 用 HMAC 签名校验，飞书用 Verification Token + 可选 AES，企业微信用 SHA1 签名 + AES
- 每个来源独立启用、独立白名单；凭据只从环境变量读
- 重复投递、签名失败、非法载荷都有确定结果，不建重复任务

## 3. 用户故事

### US-1 CI 失败自动开单

作为维护者，我在 GitHub 仓库配 webhook 指向 `http://<host>:8800/triggers/github-actions`，secret 与 `triggers.githubActions.secretEnv` 一致。workflow 失败后 pisa 自动开单，任务正文带仓库、workflow、分支和运行链接。

### US-2 群里 @ 机器人开单

作为群成员，我在白名单群 @ 机器人说「登录接口 500，帮忙看下」，pisa 建任务；其它群的 @ 和未 @ 的闲聊不建任务。

### US-3 重复投递只建一个任务

作为运维，GitHub / 飞书 / 企业微信重试同一条回调，pisa 返回成功但只建一个任务。

### US-4 伪造请求被拒绝

作为安全负责人，没有正确签名或 token 的请求返回 401/403，不进入 Router、不落任务。

### US-5 配错不拖累其它来源

作为维护者，企业微信的 AES Key 没配，启动日志告警并跳过该来源；GitHub Actions 与飞书照常工作。

## 4. 需求

配置（`pisa.config.json`）：

```json
{
  "triggers": {
    "port": 8800,
    "githubActions": {
      "enabled": true,
      "secretEnv": "PISA_GH_WEBHOOK_SECRET",
      "chatId": "<回执会话>",
      "userId": "<任务归属用户>",
      "repos": ["owner/pisa"],
      "repo": "pisa"
    },
    "feishu": {
      "enabled": true,
      "verificationTokenEnv": "PISA_FEISHU_TOKEN",
      "encryptKeyEnv": "PISA_FEISHU_ENCRYPT_KEY",
      "chatId": "<回执会话>",
      "userId": "<任务归属用户>",
      "chats": ["oc_xxx"]
    },
    "wecom": {
      "enabled": true,
      "tokenEnv": "PISA_WECOM_TOKEN",
      "aesKeyEnv": "PISA_WECOM_AES_KEY",
      "corpId": "ww123",
      "chatId": "<回执会话>",
      "userId": "<任务归属用户>",
      "users": ["zhangsan"]
    }
  }
}
```

| ID | 需求 |
| --- | --- |
| FR-001 | `Config.triggers` 可选，含 `port` 与三个来源配置；只监听 `127.0.0.1`。没有启用的来源时不监听端口 |
| FR-002 | 适配器接口固定三件事：`verify` 校验来源并返回 HTTP 状态与原因；`normalize` 把请求归一化为 `{ externalId, text, chatId, userId, repo? }` 或直接响应 / 忽略 / 拒绝；`dedupeKey` 由归一化结果生成稳定事件 id |
| FR-003 | 每个来源有 `enabled`；未启用不挂载。凭据从 `*Env` 指定的环境变量读取，缺失时启动告警并跳过该来源，不影响其它来源 |
| FR-004 | HTTP 路由为 `POST /triggers/<name>`，`name` 为 `github-actions`、`feishu`、`wecom`；企业微信额外支持 `GET`（回调 URL 验证）。未知路径 404，未知方法 405 |
| FR-005 | GitHub Actions：对原始请求体做 HMAC-SHA256，密钥来自 `secretEnv`，与 `X-Hub-Signature-256` 的 `sha256=<hex>` 做常量时间比较；缺失或不匹配返回 401 |
| FR-006 | GitHub Actions：`events` 缺省为 `["workflow_run"]`；`repos` 非空时只接受其中的 `owner/repo`；`workflow_run` 只处理 `action=completed` 且结论为失败类（`failure` / `timed_out` / `startup_failure`）的运行，`failedOnly=false` 时任何完成态都处理；不在范围的事件返回 200 并标记忽略 |
| FR-007 | GitHub Actions 去重键：`github-actions:<repo>:<run_id>:<run_attempt>`；非 `workflow_run` 事件回退到 `X-GitHub-Delivery`，再回退到原始体的 SHA-256 |
| FR-008 | 飞书：支持明文与 `{"encrypt": ...}` 两种事件订阅载荷；`encryptKeyEnv` 配置后用 AES-256-CBC（key=SHA-256(Encrypt Key)，IV 为密文前 16 字节）解密，并且只接受加密载荷，防止明文降级；`verificationTokenEnv` 配置后校验 `header.token` 或顶层 `token`，不匹配返回 403 |
| FR-009 | 飞书：`type=url_verification` 原样回 `{"challenge": ...}`；只处理 `im.message.receive_v1` 的 `text` 消息；群聊要求有 `mentions` 或正文以触发词开头；`chats` / `users` 非空时按群 id / 发送者 open_id 过滤；正文去掉 `@_user_<n>` 占位符 |
| FR-010 | 飞书去重键：`feishu:<header.event_id>`，缺失时用 `message.message_id` |
| FR-011 | 企业微信：`msg_signature = SHA1(sort(token, timestamp, nonce, encrypt).join(""))`，常量时间比较；`GET` 用 `echostr` 参与签名并返回解密后的明文 |
| FR-012 | 企业微信：AES-256-CBC 解密（key=Base64(EncodingAESKey+"=")，IV=key 前 16 字节，PKCS#7 块大小 32），校验 `receiveid` 等于 `corpId`，再解析内部 XML；只处理 `MsgType=text`；`users` 非空时按 `FromUserName` 过滤 |
| FR-013 | 企业微信去重键：`wecom:<MsgId>`，缺失时用解密后 XML 的 SHA-256；成功处理后回 `success` |
| FR-014 | 归一化事件进入 Router 时带 `channel=<适配器名>`、`isDirect=true`，正文缺触发词时补上 `cfg.trigger`；去重仍由 `Store.claimEvent` 落库 |
| FR-015 | 签名或 token 失败、非法 JSON / XML、缺少必要字段返回 4xx；签名有效但与任务无关的事件返回 200 并标记忽略；两者都不建任务 |
| FR-016 | 签名密钥、AES Key、Verification Token 不进日志、不回显、不落库 |

## 5. 验收

1. 给定正确签名与失败的 `workflow_run` 载荷，`POST /triggers/github-actions` 返回 202，Router 收到正文含仓库、workflow、分支、运行链接的事件
2. 给定错误签名，返回 401，Router 未收到事件
3. 给定同一 GitHub delivery / 飞书 `event_id` / 企业微信 `MsgId` 重投两次，适配器给出相同去重键，Router 侧只建一个任务
4. 给定签名有效但 JSON 损坏的 GitHub 载荷，返回 400；给定飞书 `content` 不是 JSON，返回 400
5. 给定仓库 / 群 / 用户不在白名单，返回 200 且不建任务
6. 给定飞书加密载荷，解密后得到与明文相同的任务正文；`token` 错误返回 403
7. 给定企业微信 `GET` 回调验证，返回解密后的 `echostr`
8. 给定 `triggers.wecom` 缺少 `aesKeyEnv` 指向的变量，启动告警并只跳过企业微信，其它来源照常挂载

## 6. 非目标

- 文件监听：它没有 HTTP 校验与载荷归一化，生命周期（watch、去抖、忽略自产文件）与回调型入口不同，不在本轮验收范围
- 向飞书 / 企业微信回消息：任务回执仍发到配置的 `chatId`，由既有通道送出
- 签名时间窗与重放保护：去重键已覆盖重复投递，重放窗口留给反向代理
- 每个来源独立端口、独立并发或独立仓库映射
