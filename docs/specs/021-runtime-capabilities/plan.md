# 021 · 实现计划

## 决策

1. 声明放配置，解析放在 `src/capabilities.ts`，不新增模块层。清单是 `Worker.run` 与 `guard` 之间唯一的契约，序列化后经 `PISA_CAPABILITIES` 传给扩展，避免扩展再读配置与状态目录。
2. `read`/`write` 是目录白名单：工作目录恒在列，声明项相对任务工作目录解析。文件工具按工具名区分读写（`isWriteTool`），bash 侧无法静态判断读写，维持 012 的工作目录边界规则，只额外施加 `blocked`、GUI、域名约束。
3. `env` 与 `worker.envAllow` 取并集。`envAllow` 是进程级基线（PATH、HOME 等），`capabilities.env` 是仓库可用的密钥；默认都不含密钥，满足默认拒绝。
4. 拒绝事件复用 progress jsonl（002 已有的 `blocked` 事件），任务结束时一次性汇总进 `tasks.audit`。不新增事件通道。
5. `gui` 是唯一的三态字段：仓库声明优先，其次全局，缺省关闭。其余字段都是加法，便于「全局给基线、仓库加例外」。
6. `Task.audit` 只存清单与违规，不存完整 env 值，避免把密钥写进台账。

## 文件

| 文件 | 改动 |
| --- | --- |
| `src/config.ts` | `CapabilityConfig`；`Config.capabilities`；`RepoConfig.capabilities` |
| `src/capabilities.ts` | 解析、清单、摘要、审计格式化 |
| `src/adapters/types.ts` | `AdapterInput.capabilities?: CapabilityManifest` |
| `src/adapters/omp.ts` | `buildEnv` 注入 `PISA_CAPABILITIES` |
| `src/worker.ts` | 解析清单、env 取清单、`readViolations`、返回 `audit` |
| `src/types.ts` | `Task.audit`、`WorkerResult.audit` |
| `src/store.ts` | `audit` 列与 `setAudit` |
| `src/router.ts` | 结果落审计（含评审任务） |
| `src/cli.ts` | `pisa show` 摘要行 |
| `src/index.ts` | 启动日志、`Worker` 注入 `CapabilitySource` |
| `extensions/guard.ts` | `parseCapabilities`、`outsideAllowed`、GUI/域名/追加禁令检查 |
| `extensions/pisa-worker.ts` | 传清单、GUI 工具拦截、读写根目录、`reason` 落事件 |

## 测试

- `tests/capabilities.test.ts`（新增）：默认值、并集与 `gui` 覆盖、清单路径绝对化、启动摘要、Store 审计往返。
- `tests/guard.test.ts`：`outsideAllowed` 替代 `outsideWorkdir`；默认拒绝 GUI/域名、显式放行、追加禁令。
- `tests/worker.test.ts`：默认不含密钥且 `PISA_CAPABILITIES` 存在；声明后密钥可见；结果带审计；`readViolations` 解析。
- `tests/router.test.ts`：worker 返回审计时落库。
- `tests/cli.test.ts`：`pisa show` 输出能力行。

## 验证

`bun test`、`bunx tsc --noEmit`，以及手动跑一次 `pisa show` 观察审计行。
