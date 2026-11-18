# 任务

- [x] 定义 `TriggerAdapter` 与 `TriggerRequest` / `TriggerEvent` / `TriggerOutcome`，去重键复用 `makeTrigger`（`src/triggers/types.ts`）
- [x] GitHub Actions 适配器：HMAC-SHA256 验签，`workflow_run` 失败完成事件，仓库与 workflow 白名单（`src/triggers/github-actions.ts`）
- [x] 飞书适配器：签名 + 300 秒窗口 + AES 解密 + `url_verification` 握手 + 群 / 用户白名单（`src/triggers/feishu.ts`）
- [x] 企业微信适配器：sha1 签名 + AES 解密 + `corpid` 校验 + `echostr` 握手 + 用户白名单（`src/triggers/wecom.ts`）
- [x] HTTP 入口 `/triggers/<name>`：状态码映射、事件 → `IncomingMessage`（`src/triggers/server.ts`）
- [x] 配置 `triggers` 与装配 `buildTriggerAdapters`，接入 `src/index.ts` 启动与关停（`src/config.ts`、`src/triggers/index.ts`、`src/index.ts`）
- [x] fake 测试：每个适配器的签名失败、重复事件去重键、非法载荷，另覆盖白名单、握手、状态码与端到端去重（`tests/triggers.test.ts`）
- [x] 文档：`docs/architecture.md`、`docs/operations.md`、`pisa.config.example.json`、`CHANGELOG.md`

## 验证

- `bun test tests/triggers.test.ts`：15 pass
- `bun test`：全量通过（含 `tests/docs-links.test.ts`、`tests/architecture-doc.test.ts`）
- `bunx tsc --noEmit`：无错误
- 复现对照：改造前真实 Actions 回调得到 `403`，改造后同一形态的伪造签名得到 `401 签名不匹配`，正确签名得到 `200 {"ok":true,"id":...}`
