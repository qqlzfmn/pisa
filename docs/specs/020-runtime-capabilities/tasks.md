# 020 · Runtime 能力清单 · Tasks

- [x] `src/capabilities.ts`：`CapabilitySpec` / `RuntimeCapabilities`、`defaultRuntime`、`resolveCapabilities`、`parseCapabilitySpec`、`outsideRoots`、`hostAllowed`
  - 验证：`tests/capabilities.test.ts` 覆盖默认值、通配域名、路径边界
- [x] `src/config.ts`、`src/types.ts`：全局/仓库/任务 `capabilities` 字段与消息透传
  - 验证：`tests/router.test.ts` 任务级整体覆盖仓库级
- [x] `src/store.ts`：`tasks.capabilities` 列、旧库迁移、`task_audit` 表与 `audit` / `auditsOf`
  - 验证：`tests/router.test.ts` 能力审计与 blocked 审计落库
- [x] `src/worker.ts`：解析生效能力、`worker.envAllow ∪ secrets`、写 `stateDir/runtime/<taskId>.json`
  - 验证：`tests/worker.test.ts` manifest 的 `write`、`gui`、`env`、声明密钥
- [x] `extensions/guard.ts`：域名、GUI、重定向、读写路径、`deny` 前缀校验
  - 验证：`tests/guard.test.ts` 默认拒绝与放行两条路径
- [x] `extensions/pisa-worker.ts`：读取 `PISA_CAPABILITIES_FILE`，bash 与文件工具越界 emit `blocked`
  - 验证：guard 单测覆盖同一 `blockBash` 入口
- [x] `src/router.ts`、`src/webhook.ts`、`src/adapters`：能力解析与审计、webhook 携带、提示词能力段
  - 验证：`tests/router.test.ts`、`tests/worker.test.ts`
- [x] 文档与示例：`README.md`、`docs/usage.md`、`docs/architecture.md`、`pisa.config.example.json`
  - 验证：按文档配置能生成对应 manifest
- [x] 回归：`bun test`、`bunx tsc --noEmit`
