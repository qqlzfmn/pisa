# 实施计划

## 结构

```
src/triggers/types.ts           TriggerAdapter / TriggerRequest / TriggerEvent / TriggerOutcome / BaseTriggerAdapter
src/triggers/github-actions.ts  HMAC-SHA256 验签 + workflow_run 归一化
src/triggers/feishu.ts          签名 + 时间戳窗口 + AES 解密 + im.message.receive_v1
src/triggers/wecom.ts           sha1 签名 + AES 解密 + echostr 握手
src/triggers/server.ts          /triggers/<name> HTTP 入口，事件 → IncomingMessage
src/triggers/index.ts           按配置装配适配器（密钥从环境变量读）
```

## 决策

- **接口只承载三个环节**：`verify` 必须能只看原始字节完成验签，因此 `TriggerRequest` 同时给 `headers`、`query`、`body`，解析留给 `normalize`。三个适配器共享 `BaseTriggerAdapter.dedupeKey`，去重键直接复用 `triggers/core` 的 `makeTrigger`，不引入第二套身份算法（SSOT）。
- **忽略与拒绝分开**：`ignore` 表示「合法但不处理」（非失败 CI、非文本消息、白名单外），响应 200 让平台停止重试；`reject` 表示「载荷非法」，给 4xx。
- **握手单独建模**：飞书 `url_verification` 与企业微信 GET `echostr` 需要原样回写，建模为 `challenge`，避免在 `normalize` 里直接吐 `Response`，这样适配器保持纯数据、可测。
- **白名单空数组 = 全拒绝**：默认安全，配置漏填不会变成「全部放行」。
- **密钥只走环境变量**：`secretEnv` / `encryptKeyEnv` / `tokenEnv` / `aesKeyEnv` 指向变量名，配置文件不落密文；缺变量时跳过适配器并 `console.error`，与 `webhook.tokenEnv` 的处理一致。
- **任务归属由配置决定**：事件的 `chatId`/`userId` 取 `triggers.chatId`/`triggers.userId`，仍要过 `Router.checkAccess` 的白名单与 git 仓库校验；仓库由适配器 `repo` 字段或 `repos[0]` 决定。
- **独立端点而非扩展 webhook**：webhook 已对外发布，改它的认证模型会破坏现有 CI 脚本；`/triggers/*` 用适配器自己的验签，二者并存。

## 验证

1. `tests/triggers.test.ts`：fake 请求覆盖每个适配器的签名失败、重复事件、非法载荷、白名单，以及 server 的状态码映射与端到端去重（真实 Store + Router）。
2. `bun test`、`bunx tsc --noEmit`。
3. 手工：起 daemon 后用 curl 打 `/triggers/github-actions` 的伪造签名与真实签名（用同一密钥算 HMAC），确认 401 / 200。
