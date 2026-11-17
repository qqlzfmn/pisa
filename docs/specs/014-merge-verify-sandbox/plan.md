# 014 合并前验证的最小权限执行 · 实现计划

## 1. 模块划分

| 模块 | 职责 | 对应需求 |
| --- | --- | --- |
| `src/env.ts` | `workerEnv(extra?)`：从 `process.env` 只拷贝基础变量，构造受限环境 | FR-001 / NFR-001 |
| `src/git.ts` | `runWithLimit(args, { cwd, env, timeoutSec })`：异步启动、超时强杀、返回输出与 `timedOut` | FR-002 / FR-003 / NFR-002 |
| `src/config.ts` | `worker.verifyTimeoutSec`，默认 600 | FR-002 |
| `src/router.ts` | `handleMerge` 验证改用 `runWithLimit` + `workerEnv`，超时与失败输出经 `redact` | FR-003 / FR-004 |

## 2. 技术决策

- **受限环境用白名单，不用黑名单**：黑名单永远漏；白名单只放行 `PATH`、`HOME`、`TMPDIR` / `TMP` / `TEMP`、`LANG` / `LC_ALL`、`TERM`。`bun test` 需要 `PATH` 定位子进程、`HOME` 定位缓存，其余不必要（NFR-001）。
- **不复用同步 `sh`**：`Bun.spawnSync` 没有超时控制，超时只能靠外部刀切，无法在进程内可靠返回。改用 `Bun.spawn` + 定时器，到点 `kill` 并 `await exited`（NFR-002）。超时直接 SIGKILL：测试进程可能无视 SIGTERM（例如被阻塞的同步循环），而验证是一次性进程，无需优雅收尾。
- **不回退到「超时也放行」**：超时等同失败，走既有 `!ok` 分支，保证主干不变（FR-003）。
- **脱敏放在回执构造处**：`detail` 由测试输出拼成，统一 `redact` 后再回复，避免测试输出把 token 带进聊天记录（FR-004）。
- **配置项默认 600**：与 Worker 的 `timeoutSec` 分开，验证是短命令，沿用 1 小时会让合并长时间无响应（FR-002）。

## 3. 接口

```ts
// src/env.ts
export function workerEnv(extra?: Record<string, string>): Record<string, string>;

// src/git.ts
export interface LimitedResult extends ExecResult { timedOut: boolean }
export function runWithLimit(
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutSec: number },
): Promise<LimitedResult>;
```

## 4. 测试策略

- `tests/router.test.ts` 新增两条集成测试，直接驱动 `handleMerge`：
  - 慢测试 + `verifyTimeoutSec = 2`：回执含「未合并 · 验证超时」，主干 commit 不变，主干没有该测试文件。
  - 打印 `process.env.GH_TOKEN` 的失败测试：回执含 `ENV_PRESENT=false`，不含真实 token、不含测试里硬编码的假 token（验证脱敏兜底）。
- 不单独为 `workerEnv` 写单测：集成测试已经覆盖「凭据不可见」这一消费方可见行为。

## 5. 风险

| 风险 | 处理 |
| --- | --- |
| 测试需要额外环境变量（如 `CI=1`）才能跑 | 现阶段不预置；需要时由 `workerEnv(extra)` 显式追加，保持默认最小 |
| `bun test` 被杀后留下子进程 | 验证命令是单进程测试运行器；SIGKILL 作用于进程组之外的单个 PID 已满足当前场景，容器级清理不在本次范围 |
