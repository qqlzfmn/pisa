# 019 · 任务清单

- [x] guard 增策略参数：`GuardPolicy` / `parsePolicy` / `checkPath` / `blockTool`，默认全拒
- [x] 写入判定：重定向目标、写类命令位置参数；`/dev/null` 等设备不算目标
- [x] 读取判定：`AMBIENT_READ_ROOTS` + `readPaths`，路径越界给出类别化原因
- [x] 网络判定：命令头与显式 URL，域名按子域放行；无目标时拒绝
- [x] GUI 判定：命令头与工具名，`gui=false` 时拒绝
- [x] `src/capabilities.ts`：`mergeCapabilities` / `assertProfile` / `resolveCapabilities` / `buildManifest` / `capabilityEnv` / `envAllowWithSecrets`
- [x] 配置：`worker.capabilities`、`repos[].capabilities`、`repos[].profiles`
- [x] 入口：`IncomingMessage.capability`（webhook body 透传），建任务时校验档位
- [x] 任务：`Task.capability` 落库与迁移，执行时重新解析
- [x] `Worker.run`：清单落盘、`capability` 日志、密钥并进 env、注入 `PISA_CAPABILITIES`
- [x] `WorkerResult.blocked` 汇总 progress 中的 `blocked` 事件
- [x] Router：逐条 `stage=blocked` 写任务日志，回执附拒绝次数
- [x] 扩展：`PISA_CAPABILITIES` → 策略，文件工具按读/写分开判定
- [x] 提示词：约束段落改为能力清单口径
- [x] 保留：`retentionDays` 到期时能力清单与进度文件一并清理
- [x] 测试：`tests/capabilities.test.ts`、`tests/guard-capabilities.test.ts`、`tests/worker-capabilities.test.ts`、`tests/router-capabilities.test.ts`、`tests/extension-policy.test.ts`
- [x] 文档：README / SECURITY / usage / architecture / CHANGELOG / 配置示例
