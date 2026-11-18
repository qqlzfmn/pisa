# 021 · 实施计划

## 1. 结构

| 文件 | 职责 |
| --- | --- |
| `src/reply-bus.ts` | 从 `web.ts` 抽出的回执总线；支持多个本机 chatId，按 chatId 缓冲 |
| `src/manager.ts` | 本机动作的公共链路：串行化、把动作翻译成一条 `IncomingMessage`、收集回执并判定成功；`/state` 与 `/tickets` 的投影 |
| `src/api.ts` | 管理路由与服务器：鉴权、`/state`、`/tickets/*`、`/executor/*`、`api.json` 发现文件 |
| `src/status.ts` | 增加由快照直接渲染文本的入口，CLI 不再持有 `Store` |
| `src/log.ts` | 增加日志尾部格式化，Web 详情与 `/tickets/:id` 共用 |
| `src/store.ts` | `executorPaused()` / `setExecutorPaused()`，键 `executor.paused` |
| `src/router.ts` | `fill()` / `drainOnce()` 尊重暂停；`retry` 命令；公开 `planRewindFor()` |
| `src/config.ts` | `CommandKind` 增加 `retry`，`COMMANDS` 增加条目（帮助、菜单、错拼建议同源） |
| `src/cli.ts` | 新退出码、HTTP 客户端、六个管理命令；删除 `cancel` |
| `src/index.ts` | 常驻启动管理接口，写 `api.json`，注入 `ReplyBus` |

## 2. 决策

**接口常驻，与控制台共用服务。** 控制台默认关闭，管理接口必须随守护进程一起起。两者共用同一端口（`web.port`，默认 8787）与同一 token；URL、token 与 pid 写进 `stateDir/api.json`（0600），CLI 自动发现，不再需要用户传 token。端口被占用且控制台关闭时退回系统分配端口，避免管理接口因端口冲突让守护进程起不来；控制台开启时直接报错，因为用户预期的页面地址不应悄悄改变。

**凭证只走请求头。** 页面用 `?token=` 开一次再换 cookie，这是浏览器约束；脚本不需要，所以管理路由显式拒绝查询参数与 cookie。`Host` 校验挡住 DNS rebinding。

**动作复用 IM 命令。** `stop` / `retry` / `merge` / `rewind` 都由 `manager.ts` 翻译成 `${trigger} <命令>` 消息，交给同一个 `Router.handle`，白名单、状态机、合并闸门不出现第二份实现。接口只负责把回执与终态转成结构化结果。

**重试不是重放。** 新任务号、新触发记录，避免改写历史任务与已发生的副作用；有分支时通过 `continue` 语义复用分支和上下文，没有分支时按原需求新建。

**暂停是持久状态。** 放在 `meta` 表，重启后仍然暂停；`fill()` 每 800ms 读一次，代价是一条主键查询。运行中的任务不打断，暂停只拒绝新补位。

**CLI 的传输目标可注入。** `Io` 增加 `api?: ApiTarget`；缺省从 `api.json` 或 `PISA_API_URL` / `PISA_API_TOKEN` 发现。测试起真实 `Bun.serve`（`port: 0`），覆盖鉴权与网络路径，而不是绕过路由。

## 3. 退出码

| 码 | 含义 | 触发 |
| --- | --- | --- |
| 0 | 正常 | 命令完成，守护进程健康 |
| 1 | 需重启 | 连不上管理接口；`/state` 报心跳过期 |
| 2 | 部件错误 | 任务失败、5xx、合并/撤销未成功、响应不可解析 |
| 3 | 待配置 | 没有 `api.json` 也没有 `PISA_API_TOKEN`；401/403 |
| 4 | 用法 | 参数、仓库别名、白名单 |
| 5 | 找不到 | 任务号不存在 |
| 6 | 不可运行 | 状态不允许（终态取消、非失败任务重试等） |
| 7 | 等待超时 | `wait` / `run` 超时 |

## 4. 验证

- `tests/api.test.ts`：鉴权矩阵（无 token / 错 token / 查询参数 / 非本机 Host）、`/state` 与 `/tickets/:id` 契约、stop/retry/merge/rewind 的状态校验、暂停后 `fill()` 不取任务。
- `tests/cli.test.ts`：现有用例按新码修正；新增管理命令的 JSON 与 0/1/2/3/4/5/6/7 退出码，跑在真实 `Bun.serve` 上。
- `tests/router.test.ts`：`retry` 命令、暂停开关。
- 全量 `bun test`、`bunx tsc --noEmit`。
