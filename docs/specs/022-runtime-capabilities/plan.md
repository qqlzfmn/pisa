# 022 · 实施方案

## 分层

```
配置（capabilities 声明）
  ↓ capabilitiesFor(worker, repo) → Capabilities
任务创建：runtimeManifest(caps, workdir, envAllow) → RuntimeManifest
  ├→ tasks.capabilities（审计，落库）
  ├→ PISA_CAPABILITIES（扩展读）
  └→ 子进程 env（workerEnv 用 manifest.env）
执行：guard.blockBash(cmd, GuardPolicy) / outsideReadable / outsideWritable
  └→ blocked{reason} → progress jsonl → Router 写任务日志（guard）
```

纯函数在前（`src/capabilities.ts`、`extensions/guard.ts`），接线在后（`pisa-worker.ts`、`worker.ts`、`router.ts`）。

## 模块

| 文件 | 改动 |
| --- | --- |
| `src/capabilities.ts`（新） | `CapabilityConfig`、`Capabilities`、`DEFAULT_CAPABILITIES`、`normalizeCapabilities`、`mergeCapabilities`、`capabilitiesFor`、`RuntimeManifest`、`runtimeManifest`、`formatManifest` |
| `src/config.ts` | `RepoConfig.capabilities`、`worker.capabilities`；`loadConfig` 按配置文件目录解析目录；`merge` 覆盖仓库 capabilities |
| `src/types.ts` | `Task.capabilities?: RuntimeManifest` |
| `src/store.ts` | tasks 列 `capabilities TEXT`，迁移、`toTask` 解析、`insertTask` 写入 |
| `src/router.ts` | 建任务时算 manifest；始终启动进度监听，`blocked` 写 `guard` 日志；启动时写 `capabilities` 日志 |
| `src/worker.ts` | 用 manifest 构造 env，传给 adapter |
| `src/adapters/types.ts`、`omp.ts` | `AdapterInput.capabilities`；`PISA_CAPABILITIES`；提示词约束段由 manifest 渲染 |
| `extensions/guard.ts` | `GuardPolicy`；读/写目录分离；网络、GUI、`blockedCommands`、重定向与文件命令路径 |
| `extensions/pisa-worker.ts` | 解析 `PISA_CAPABILITIES`，按工具读写分类校验，blocked 事件带 reason |
| `src/index.ts` | 启动打印每仓库能力摘要 |

## 关键取舍

- **允许项只并集**：默认全拒，仓库只能加。收窄要靠改 `worker` 默认或别的仓库，不引入「repo 覆盖并可删减」的第二套语义。
- **能力落在任务上**：`tasks.capabilities` 快照了 `workdir` 与目录，事后审阅不再依赖当时配置。
- **旧任务缺列 = 默认全拒**：不做兼容分支，字段缺失就走 `DEFAULT_CAPABILITIES`。
- **`git fetch/pull` 一律拒绝**：远端来自仓库配置，命令里无法判定目标，「无法判定」按拒绝处理。
- **包管理器映射到注册表域名**：否则 `bun install` 这类没有显式目标域名的命令只能永久拒绝；映射给运维一个可操作的放行项。
- **路径校验是尽力而为**：只覆盖文件命令参数与重定向目标，脚本内部读写不在覆盖内（写进非目标）。

## 验证

- `tests/capabilities.test.ts`：默认拒绝、放行、合并、manifest、格式化
- `tests/guard.test.ts`：既有 git 用例保持通过；新增网络/GUI/目录/重定向/包管理器用例
- `tests/worker.test.ts`：manifest 进入 env 与 `PISA_CAPABILITIES`
- `tests/router.test.ts`：任务落库带 capabilities、日志有 capabilities 与 guard 行
- `tests/adapter.test.ts`：`PISA_CAPABILITIES` 与提示词约束段
- `bun test`、`bunx tsc --noEmit`
