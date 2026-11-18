# 022 · 任务

- [x] `src/capabilities.ts`：`CapabilityConfig` / `Capabilities` / `DEFAULT_CAPABILITIES` / `normalizeCapabilities` / `mergeCapabilities` / `capabilitiesFor` / `RuntimeManifest` / `runtimeManifest` / `parseManifest` / `describeCapabilities`
- [x] `src/config.ts`：`repos[].capabilities`、`worker.capabilities`，目录按配置文件目录解析
- [x] `src/types.ts`：`Task.capabilities`
- [x] `src/store.ts`：`capabilities` 列迁移、读写
- [x] `extensions/guard.ts`：`GuardPolicy`，读/写目录分离，网络、GUI、`blockedCommands`、文件命令与重定向路径
- [x] `extensions/pisa-worker.ts`：读 `PISA_CAPABILITIES`，按工具分类校验，`blocked` 带 reason
- [x] `src/worker.ts`：manifest 构造 env
- [x] `src/adapters/`：`AdapterInput.capabilities`、`PISA_CAPABILITIES`、提示词约束段
- [x] `src/router.ts`：建任务算 manifest 落库、`guard`/`capabilities` 日志、进度监听始终运行
- [x] `src/config-edit.ts`：保存配置时按 alias 合并，保留 Web 不编辑的 `capabilities`
- [x] `src/index.ts`：启动打印每仓库能力摘要
- [x] `tests/`：新增 `capabilities.test.ts`；`worker-extension.test.ts` 走扩展接线；`guard.test.ts`、`router.test.ts`、`adapter.test.ts` 覆盖默认拒绝与显式放行两条路径
- [x] 文档：README、`pisa.config.example.json`、`docs/architecture.md`、`docs/operations.md`、`docs/usage.md`
- [x] 验证：`bun test`（416 通过）、`bunx tsc --noEmit`（无错误）
