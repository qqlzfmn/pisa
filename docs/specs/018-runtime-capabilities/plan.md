# 018 · 实现计划

## 1. 模块划分

| 模块 | 变更 | 对应需求 |
| --- | --- | --- |
| `src/capabilities.ts`（新增） | `CapabilityConfig` / `Capabilities` / `BlockedCall` / `AuditEntry`；`resolveCapabilities()` 叠加全局、仓库、任务三层；`capabilitiesForTask()` 优先任务快照；`capabilityManifest()` 把 worktree 与系统临时目录并入目录清单；`capabilityText()` 生成 prompt/日志用的事实清单 | FR-001、FR-002、FR-004 |
| `src/config.ts` | `RepoConfig.capabilities?`、`worker.capabilities?` | FR-001 |
| `src/types.ts` | `Task.capabilities?`、`Task.audit?`、`WorkerResult.blocked?` | FR-002、FR-011 |
| `src/store.ts` | `tasks` 增 `capabilities`、`audit` 列与迁移；插入时写能力快照；`appendAudit()` 追加并截断 | FR-002、FR-011、FR-013 |
| `src/worker.ts` | 按任务能力解析 env；注入 `PISA_CAPABILITIES` 与 `PISA_CAP_GUI`；任务结束后从 progress 文件读取 `blocked` 返回 | FR-004、FR-011 |
| `src/router.ts` | 建任务时快照能力；执行结束把 `blocked` 写审计与任务日志 | FR-002、FR-011 |
| `src/adapters/omp.ts` | prompt 的约束段改为动态能力清单 | FR-004、FR-010 |
| `src/cli.ts` | `--cap-*` 参数；任务创建时合并到快照；`show` 输出能力摘要与审计条数 | FR-003、FR-012 |
| `src/status.ts` | `TaskJson` 增 `capabilities`、`audit` | FR-012 |
| `src/index.ts` | 启动日志打印每仓库能力与内置 blocked commands；`Worker` 传入 `cfg.repos` | FR-005 |
| `extensions/guard.ts` | 能力参数 `GuardCapabilities`；目录、写入目标、读取路径、域名、GUI、`blocked` 检查；`BUILTIN_BLOCKED` | FR-006–FR-010、FR-014 |
| `extensions/pisa-worker.ts` | 解析 `PISA_CAPABILITIES`；文件工具按读/写能力校验；`blocked` 事件带原因 | FR-006、FR-011 |

## 2. 关键决策

- **默认目录基线 = worktree + `os.tmpdir()` + `/tmp`**。macOS 的 `os.tmpdir()` 是 `/var/folders/...`，与 `AGENTS.md` 约定的 `/tmp` 不是同一路径；两者都保留，才能既支持临时脚本又保持 `rm -rf /tmp/x` 放行。其余路径默认拒绝。依据 FR-014 与 `AGENTS.md` 的临时脚本约定。
- **任务快照而非实时解析**。能力随任务落库，避免配置在中途修改导致同一任务前后权限不一致；也满足「运行中任务可审计」。依据 FR-002。
- **任务级放行只从 CLI 进入**。IM/webhook 不暴露能力参数，避免外部消息放大权限。依据 FR-003。
- **能力清单经环境变量传给 guard**。`PISA_CAPABILITIES` 是 JSON，`PISA_CAP_GUI` 单独存在便于审计与测试；不新增文件协议。依据 FR-004。
- **审计从 progress jsonl 回收**。guard 已被设计为单向上报，Worker 在进程结束后读取 `blocked` 行并交给 Router 落库；progress 关闭时也会执行，避免审计依赖 `notifications.progress`。依据 FR-011。
- **网络检查按显式主机名**。只校验能解析出主机的命令；隐式注册表访问列为非目标，避免误伤 `bun test` 之类本地命令。

## 3. 数据模型

`CapabilityConfig`（配置输入）：

```ts
{ read?: string[]; write?: string[]; env?: string[]; domains?: string[]; gui?: boolean; blocked?: string[] }
```

`Capabilities`（任务快照，字段名与配置不同）：

```ts
{ readDirs: string[]; writeDirs: string[]; env: string[]; domains: string[]; gui: boolean; blocked: string[] }
```

`CapabilityManifest`（传给 guard）：在 `Capabilities` 基础上把 worktree 与系统临时目录并入 `readDirs` / `writeDirs`。

`AuditEntry`：`{ tool, detail, reason, at }`。

## 4. 测试策略

- `tests/capabilities.test.ts`：三层叠加、默认值、目录解析、快照优先、manifest 基线、prompt 文本。
- `tests/guard.test.ts`：默认拒绝与显式放行两套用例，覆盖目录读/写、重定向、域名、GUI、`blocked`、文件工具路径；既有 git/破坏性命令用例保持通过。
- `tests/worker.test.ts`：子进程 env 只含能力变量；`PISA_CAPABILITIES`、`PISA_CAP_GUI` 生效；`blocked` 从 progress 回收。
- `tests/router.test.ts`：任务快照落库；Worker 返回的 blocked 进入任务审计与日志。
- 全量 `bun test` 与 `bunx tsc --noEmit` 作为收口验证。

## 5. 复杂度记录

无新增依赖、无新增部署单元。guard 仍是文本匹配，不引入 shell AST 或沙箱；已知限制写入 `docs/usage.md` 与 `docs/architecture.md`。
