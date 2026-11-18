# 017 · 实现计划

## 1. 模块划分

新增 `src/triggers/`，与 `src/channels/`（出站通道）、`src/adapters/`（agent 适配器）并列：

| 文件 | 职责 | 对应需求 |
| --- | --- | --- |
| `types.ts` | `TriggerRequest`、`TriggerPayload`、`TriggerOutcome`、`TriggerAdapter` | FR-002 |
| `github-actions.ts` | HMAC-SHA256 校验、`workflow_run` 归一化、仓库白名单 | FR-005～007 |
| `feishu.ts` | Verification Token、AES 解密、URL 验证、群/用户白名单 | FR-008～010 |
| `wecom.ts` | SHA1 签名、AES 解密、GET echostr、XML 解析、用户白名单 | FR-011～013 |
| `index.ts` | 从配置与环境变量构建适配器；缺凭据时收集告警 | FR-003 |
| `server.ts` | `/triggers/<name>` 路由、体大小限制、`verify → normalize → dedupeKey → Router` 分发 | FR-004、FR-014、FR-015 |

## 2. 技术决策

| 决策 | 选择 | 依据 |
| --- | --- | --- |
| 加密实现 | `node:crypto` | 仓库无运行时依赖；Bun 兼容 Node 内置模块 |
| 原始体 | `Request.text()` 后交给适配器 | GitHub HMAC 与飞书解密都要求原始字节；JSON 重新序列化会破坏签名 |
| 常量时间比较 | `timingSafeEqual`（长度先比） | 避免签名/ token 的时序侧信道 |
| HTTP 外壳 | 复用 `Bun.serve` + `createTriggerHandler(Request): Response` | 与 `web.ts` 一致，测试可直接用 `new Request` 喂，不占端口 |
| 企业微信 XML | 只提取 `Encrypt`、`MsgType`、`Content`、`FromUserName`、`MsgId` 五个标签 | 回调 XML 是扁平结构，引入 XML 依赖不值得；未知标签忽略 |
| 飞书加解密 | AES-256-CBC + 自动 PKCS#7 | 飞书协议使用标准 AES 块大小 16 |
| 企业微信加解密 | AES-256-CBC，`setAutoPadding(false)` 后手工去 32 字节块补位 | 微信系协议 PKCS#7 块大小是 32，Node 默认只接受 ≤16 |
| 去重 | 适配器产出稳定 id，Router 的 `claimEvent` 落库 | 已有唯一事实源，不重复实现去重表 |
| 入口正文 | 不带触发词时补 `cfg.trigger` | `dmWithoutTrigger=false` 时触发器仍可用；`isDirect=true` 与 webhook 行为一致 |

## 3. 数据流

```
POST /triggers/<name>
  → 读原始体（上限 256 KiB）
  → adapter.verify(req)         失败：4xx，结束
  → adapter.normalize(req)      reply：直接返回；ignore：200；reject：4xx
  → adapter.dedupeKey(payload)  稳定事件 id
  → router.handle(IncomingMessage{eventId, channel, isDirect:true, ...})
  → 202 / adapter 指定的 ack
```

## 4. 配置与环境

- `triggers` 缺省不监听端口；三个来源各自 `enabled`
- 凭据一律通过 `*Env` 间接引用：`secretEnv`、`verificationTokenEnv`、`encryptKeyEnv`、`tokenEnv`、`aesKeyEnv`
- `chatId` / `userId` 是任务归属与回执目标，语义与 `webhook` 相同；来源自己的 `repos` / `chats` / `users` 只做来源白名单
- 构建函数注入 `env`，测试不需要污染 `process.env`

## 5. 测试策略

`tests/triggers.test.ts`，全部 fake，不联网、不占端口：

- GitHub Actions：正确/错误签名、非法 JSON、重复 delivery、仓库白名单、成功运行不触发
- 飞书：明文、AES 加密、错误 token、URL 验证、重复 `event_id`、群白名单、坏 `content`
- 企业微信：加密消息、错误签名、错误 `corpId`、重复 `MsgId`、GET `echostr`、非文本消息
- HTTP 分发：未知路径、签名失败不调用 Router、事件正文补触发词、非法载荷 400
- 工厂：缺环境变量只跳过对应来源

企业微信的加密、签名辅助函数在测试内实现（与适配器互逆），避免测试复用被测代码。
