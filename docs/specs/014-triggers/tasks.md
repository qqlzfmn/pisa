# 014 · 任务拆分（tasks）

对应 [spec.md](./spec.md) 与 [plan.md](./plan.md)。按顺序执行，每步独立可验证。

## T1 配置

- [x] `src/config.ts`：`TriggersConfig`、`GithubActionsTriggerConfig`、`FeishuTriggerConfig`、`FileTriggerConfig`，挂到 `Config.triggers`
- 验证：`tsc --noEmit`；未配置时现有测试不变

## T2 接口与工具

- [x] `src/triggers/types.ts`：`TriggerRequest` / `TriggerEvent` / `TriggerAdapter` / `TriggerSource` / `TriggerReply`
- [x] `src/triggers/verify.ts`：HMAC-SHA256、SHA-256、常量时间比较、JSON 对象解析
- 验证：签名工具被两个适配器共用，无重复实现

## T3 GitHub Actions 适配器

- [x] `verify`：`X-Hub-Signature-256` HMAC 校验
- [x] `normalize`：`workflow_run` + `completed` + 结论/仓库/分支过滤；正文含运行链接
- [x] 去重键 `github-actions:<repo>:<run_id>:<run_attempt>`
- 验证：`tests/triggers.test.ts` 中签名失败、重复事件、非法载荷、过滤用例

## T4 飞书适配器

- [x] `handshake`：`url_verification` 回 challenge，可选验证 token
- [x] `verify`：SHA-256 签名 + 300 秒时间窗
- [x] `normalize`：文本消息、p2p/群 @、发送者白名单、`feishu:<event_id>` 去重键
- 验证：同上四类用例 + 群 @ 补触发词

## T5 文件监听源

- [x] `src/triggers/files.ts`：`fs.watch` + 去抖 + 内容摘要去重键
- 验证：临时目录写入 → 投递一条；同内容重写键不变；不存在路径只告警

## T6 HTTP 分发

- [x] `src/triggers/hub.ts`：`POST /triggers/<path>`、405/404/413、握手 → 验签 → 归一化 → 投递
- [x] `src/triggers/index.ts`：`buildTriggers` 装配，缺凭据跳过
- 验证：直接调用 `receive` 的用例；启动时端口与日志

## T7 接线与文档

- [x] `src/index.ts`：启动、日志、shutdown 停止
- [x] `pisa.config.example.json`、`README.md`：配置示例与各来源说明
- 验证：`bun test`、`bunx tsc --noEmit`
