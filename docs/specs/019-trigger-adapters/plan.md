# 019 · 实施计划

## 1. 结构

```
src/triggers/
  types.ts            TriggerAdapter、TriggerOutcome、TriggerError、dispatch
  github-actions.ts   HMAC 签名 + workflow_run 归一
  feishu.ts           X-Lark-Signature + im.message.receive_v1 / url_verification
  wecom.ts            msg_signature + AES 解密 + 文本消息
  file-watch.ts       fs.watch 源 + 路径白名单
  http.ts             多适配器单端口分发
  index.ts            按配置装配
```

接口按验收的三件事拆开，一个适配器只写这三段：

```ts
interface TriggerAdapter<Raw, Payload> {
  readonly name: string;
  verify(raw: Raw): Promise<Payload>;          // 验签、解析；失败抛 TriggerError
  normalize(payload: Payload): TriggerOutcome | null; // 白名单 + 归一；null = 忽略
  dedupeKey(payload: Payload): string;         // 去重键
}
```

`dispatch` 只做一件事：`verify → normalize → messageKey ??= dedupeKey → handle`。core 不知道入口协议，Router 的去重与线程逻辑原样复用。

`TriggerOutcome` 同时承载协议级回执（飞书 challenge、企业微信 `success`）：`reply: { body, contentType }` 为空时回 `{ok:true}`。

## 2. 关键取舍

| 决策 | 备选 | 理由 |
| --- | --- | --- |
| 新目录 `src/triggers/`，与 `src/adapters/`（Agent CLI 适配）分开 | 混进 `src/adapters` | 两者只是名字像：一个是执行器，一个是事件入口，合并会让目录语义失真 |
| 三个 HTTP 入口共用一个端口、按路径分发（文件监听不走 HTTP） | 每个适配器一个端口 | 反向代理与端口白名单只需配一次；路径即入口名，直观 |
| 适配器归一化到 `IncomingMessage`，任务由 Router 建 | 适配器直接写库 | 白名单（`checkAccess`）、触发身份、编辑语义、回执全部只有一份实现 |
| 任务请求者固定为 `triggers.userId`，平台发送者放 `actor` | 用平台 id 当请求者 | `whitelist.users` 是 pisa 的身份体系；平台 id 另立白名单会分叉。谁可以触发由适配器自己的 `users` 白名单管 |
| GitHub Actions 只对 `workflow_run` 的失败结论开单 | 所有事件都开单 | 成功事件开单等于噪音；其余事件保留忽略回执，方便先接上再按需扩展 |
| 去重键选择「事件自身 id」而不是「投递 id」 | `X-GitHub-Delivery` | 同一次 run 可能被重投或换投递 id 重发，按 run id 去重才真的不重复 |
| 文件监听不递归子目录、不做停机补发 | 递归 + 事件日志 | 递归 watch 在各平台语义不一（Bun/Node 版本差异），出问题难定位；停机期间的变化重启后以当下状态计，事件日志属于另一个量级的需求 |
| 飞书/企业微信必须验签，不接受「只填 token」 | 提供免签模式 | 免签模式会让公网入口可被任意伪造，安全性换便利性不值 |

## 3. 配置

```jsonc
"triggers": {
  "chatId": "<回执会话>",
  "userId": "<任务请求者，必须在 whitelist.users>",
  "repo": "pisa",                       // 缺省用第一个仓库
  "http": { "enabled": true, "port": 8790 },
  "githubActions": { "enabled": true, "secretEnv": "PISA_GH_ACTIONS_SECRET", "repos": ["owner/pisa"], "conclusions": ["failure", "timed_out"] },
  "feishu": { "enabled": true, "secretEnv": "PISA_FEISHU_ENCRYPT_KEY", "chats": ["oc_xxx"], "users": ["ou_xxx"] },
  "wecom": { "enabled": true, "tokenEnv": "PISA_WECOM_TOKEN", "aesKeyEnv": "PISA_WECOM_AES_KEY", "users": ["zhangsan"] },
  "fileWatch": { "enabled": true, "debounceMs": 500, "paths": [{ "path": "build/last.log", "prompt": "构建日志变化，检查失败原因：{path}" }] }
}
```

路径按配置文件所在目录解析，与 `repos[].path` 一致。

## 4. 改动面

- `src/config.ts`：`TriggersConfig`、`DEFAULT_TRIGGERS_PORT`、相对路径解析
- `src/triggers/*`（新）
- `src/index.ts`：装配 `startTriggers` / 关停
- `pisa.config.example.json`、`docs/architecture.md` 4.2/4.5、`docs/operations.md`、`CHANGELOG.md`
- `tests/trigger-adapters.test.ts`（新）

## 5. 测试策略

适配器层用真实 `fetch` 形状的 `Request` 打到 `makeTriggersHandler`，`handle` 换成记录器；重复事件额外用内存库 `Store.createTaskFromTrigger` 落一次，证明去重键在持久化口上只剩一个任务：

- 签名：缺签名/错的签名/窗口外时间戳 → 401，且 handle 没被调用
- 重复：同一 run id 换 delivery、同一 message_id、同一 MsgId 各投两次 → 同一 `messageKey`，库里 1 个任务
- 非法载荷：非 JSON、缺字段、非文本消息 → 400/403，且没有任务
- 白名单：仓库、群、用户、路径各自越界 → 403
- 文件监听：真实写文件 → 回调收到消息；连续两次写只合并成一条
