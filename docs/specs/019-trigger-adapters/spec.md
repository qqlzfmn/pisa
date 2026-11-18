# 019 · 通用 Trigger 适配层

- 状态：implemented
- 关联：017（触发器幂等与线程归属）、006/007（GitHub 评论）、004（主动发现）、009（定时）

## 1. 问题

外部事件只能靠三种方式进入 pisa：IM 通道、webhook 的私有 JSON 约定、GitHub 评论轮询。真实事件因此接不进来：

- **CI 失败**要人写外部脚本把 GitHub Actions 载荷翻译成 `{prompt}` 再带上 `x-pisa-token`；直接投 GitHub 原始载荷会被拒。
- **群里被 @**（飞书、企业微信）没有入口；`Proactive` 只认关键词与定时探针，探针是轮询，延迟至少一个间隔。
- **文件变化**（构建产物、外部系统落盘）没有任何入口，只能定时探针比对。

复现（当前实现，2026-11-18）：

```bash
# 原始 GitHub Actions 载荷
curl -X POST http://127.0.0.1:8799/event -H "x-pisa-token: $T" \
  -d '{"action":"completed","workflow_run":{"conclusion":"failure"}}'
# → 400 prompt required
# 伪造签名 + 自带 prompt 也照样收下
curl -X POST ... -H "x-github-signature-256: sha256=deadbeef" -d '{"prompt":"CI failed"}'
# → 200 {"ok":true}
```

`src/webhook.ts` 只有一条常量时间 token 比较，没有载荷签名校验；`grep -rniE "feishu|wecom|fs\.watch"` 在 `src/` 里没有命中。归一化逻辑散在各入口，新增一个入口要重写一遍「验签 → 取字段 → 拼 IncomingMessage」。

## 2. 需求

FR-001 定义 `TriggerAdapter`：验证（鉴权 + 解析）、归一化（外部载荷 → `IncomingMessage`）、去重键三件事各有唯一落点；core 只拿归一化结果。

FR-002 GitHub Actions：`X-Hub-Signature-256` HMAC-SHA256 校验必需，失败拒绝；`workflow_run` 失败结论转成任务，其余事件忽略。

FR-003 飞书：`X-Lark-Signature`（`sha256(timestamp + nonce + EncryptKey + body)`）校验收敛请求，时间戳窗口外拒绝；`im.message.receive_v1` 文本消息转成任务，`url_verification` 回 challenge。

FR-004 企业微信：`msg_signature`（sha1 排序拼接）校验，AES-256-CBC 解密回调正文；文本消息转成任务，GET 校验回解密后的 echostr。

FR-005 文件监听：配置路径（文件或目录）变化时开单，500ms 内同一路径的多次事件合并。

FR-006 配置启用与白名单：每个适配器独立 `enabled`；GitHub 按仓库、飞书按群与发送者、企业微信按发送者、文件监听按路径做白名单，白名单外一律拒绝且不建任务。

FR-007 去重：同一外部事件重复投递只建一个任务，去重键进 `messageKey`，跨重启生效（复用 `triggers` 表）。

FR-008 不改变既有入口：webhook、IM、GitHub 评论、CLI 行为与接口不变。

## 3. 非目标

- 不做飞书/企业微信的消息回发（回执仍走配置的 chatId，由 pisa 自己的通道投递）。
- 不做 GitHub Actions 以外的事件签名方案（如 GitLab、Bitbucket）。
- 不实现文件监听的事件队列持久化：进程停机期间的变化不补发，重启后以新状态计。

## 4. 验收

1. `TriggerAdapter` 接口与 `dispatch` 存在，适配器只实现三段逻辑。
2. GitHub Actions、飞书、企业微信、文件监听四个入口可用，`tests/trigger-adapters.test.ts` 覆盖各自签名失败、重复事件、非法载荷。
3. 白名单外的仓库/群/用户/路径被拒绝（403），且不产生任务。
4. `bun test`、`bunx tsc --noEmit` 通过。
