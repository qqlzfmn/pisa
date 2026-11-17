# 014 · 实现计划

## 1. 结构

| 文件 | 职责 |
| --- | --- |
| `src/board.ts` | 状态快照与文本看板：`snapshot(store, paused, now)`、`formatBoard(snapshot)`、`formatDuration` |
| `src/mgmt.ts` | `createMgmtHandler(deps)` 返回 `(req) => Response`；`startMgmtServer(deps)` 用 `Bun.serve` 绑定 `127.0.0.1` |
| `src/cli.ts` | `runCli(argv, deps)`：解析子命令、调管理接口、映射退出码；不碰 store |
| `src/pisa.ts` | CLI 入口，`process.exit(await runCli(...))` |
| `src/router.ts` | 抽出 `submitTicket` / `stopTicket` / `retryTicket` / `mergeTicket` / `rewindTicket`，IM 与 API 共用 |
| `src/store.ts` | `requeue(id)`：失败/取消任务回到排队 |
| `src/log.ts` | `readTaskLog(stateDir, id)`：解析 JSONL 日志 |
| `src/index.ts` | 启动管理服务；关停时一并停止 |

## 2. 决策

- **HTTP 资源叫 ticket**：验收标准给定 `/tickets/:id`。领域对象仍是 `Task`，`ticket` 只是对外资源名，响应体字段沿用 `Task`，不另立模型。
- **鉴权顺序**：回环主机名 → token → 路由。任一失败立即 403，不读取 store。
- **共用操作实现**：merge/rewind/stop 的语义只在 Router 里写一次，IM 处理器只负责权限检查与回复文案；API 直接调用同一方法。避免 IM 与 API 行为漂移。
- **执行器暂停**：只在 `fill()` 入口判断 `paused`，不改变任务状态，不打断运行中任务。语义等于「暂停接单」。
- **retry**：只对 `failed` / `cancelled` 生效，回到 `queued` 并清空执行痕迹；`succeeded` 重跑会与分支/PR 语义冲突，返回 409。
- **CLI 退出码映射**：`needsRestart` → 1；HTTP 401/403 或本地缺 token/禁用 → 3；网络错误、5xx、4xx、`ok:false` → 2。
- **JSON 输出**：单行 `JSON.stringify`，不做缩进，方便管道与 `jq`。
- **测试注入**：`runCli` 接受 `fetchImpl`，单测用假实现；另有一条真实 `Bun.serve` 集成测试验证鉴权与回环约束。

## 3. 测试策略

- `tests/mgmt.test.ts`：用 `Request` 直接调 handler，覆盖状态、建单、重试、停止、暂停、日志、合并/撤销的 404/409 与鉴权、主机名拒绝。
- `tests/cli.test.ts`：
  - 假 fetch：status 文本与 `--json`、run/logs/merge/rewind 输出、退出码 0/1/2/3
  - 真实服务：正确 token 0，错误 token 3，且不泄露任务字段
- 现有 `tests/router.test.ts` 只改 `formatDuration` 的导入来源；IM 行为测试保持原样，用来证明重构没有改变语义。

## 4. 风险

- `merge` 在看护模式下仍要退出进程（自举依赖）。共用实现只返回 `needsRestart`，退出由 IM 处理器与 API 各自在响应之后执行。
- `rewind` 依赖 `gh` 与 git 探测，测试沿用 013 的注入方式，不联网。
- 管理接口默认开在 8800；若端口被占用，启动失败只告警，不阻断主进程。
