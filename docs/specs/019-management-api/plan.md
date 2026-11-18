# 019 · 实现计划

## 结构

| 文件 | 职责 |
| --- | --- |
| `src/api.ts` | 管理接口路由：状态、任务、动作、执行器；`reason` 映射 |
| `src/channels/reply-bus.ts` | 回执总线：本机会话（`web`、`cli`）缓冲，其余转投真实通道 |
| `src/web.ts` | 鉴权、`/health`、`/ui` 与控制台入口；把 `/api/*` 交给 `api.ts` |
| `src/http.ts` | `HttpError(status, message, reason)`、`json()` 响应助手 |
| `src/cli.ts` | 纯 HTTP 客户端：参数解析、命令分发、退出码 |
| `src/router.ts` | 执行器暂停开关（`pause/resume/isPaused`）、`retry` 命令、admin 入口跳过用户白名单 |

## 关键取舍

### 控制面常驻而不是 `web.enabled` 开关
CLI、脚本、agent 都需要一份接口。若接口随 `web.enabled` 关闭，CLI 要么继续直连 SQLite（本特性要消灭的耦合），要么只在开了控制台时可用。代价是守护进程固定占一个端口：端口不可用时只告警、任务照常运行，CLI 以退出码 1 报告不可达。

### CLI 不写库
守护进程是唯一写入口。CLI 提交任务走 `POST /api/tasks`，与 IM 入口共用 `makeTrigger` + `createTaskFromTrigger` 去重账本。代价：守护进程没起来时 `pisa task` 不能离线入队，退出码 1 明确提示重启。

### 动作结果由状态判定，不解析回执正文
`cancel`/`resume`/`merge`/`rewind` 的结果看任务状态、`cancelRequested`、`merge` 效果行；接口在动作前做存在性与前置状态检查，因此不需要从中文回执里正则提取语义。

### 暂停只在内存
`Router.paused` 不落库。重启即恢复执行，正好与「退出码 1 用重启解决」的语义一致。

### 回执归属
管理接口投递的任务用 `chatId = "api"`（`API_CHAT_ID`）：`ReplyBus` 缓冲自己的 chatId（`web`）与构造时传入的本机会话列表（`[API_CHAT_ID]`），其余 chatId 原样转投真实通道。接口请求的同步回执从缓冲里 `take`，任务完成后的异步通知既不会漏进 Telegram，也不会串到页面。

## 退出码映射

| 来源 | 退出码 |
| --- | --- |
| 接口 401 `auth` | 3 |
| 接口 404 `not_found` | 3 |
| 接口 409 `config` | 3 |
| 接口 409 `state` | 2 |
| 接口 500 `component` | 2 |
| fetch 失败（连接被拒、超时） | 1 |
| 任务 failed / cancelled / rewound（`wait`） | 2 |
| 任务 paused、执行器暂停、心跳过期 | 1 |

## 测试

- `tests/api.test.ts`：鉴权（含 query token 无效）、越权（仓库不在白名单）、`/api/state` 与暂停、详情与日志、过滤、看板、投递（`channel=api`、幂等、回执不外泄）、六个动作的状态判定与合并、撤销。
- `tests/cli.test.ts`：真实 `Bun.serve` + 真实 Router，逐命令断言输出与退出码；覆盖 0/1/2/3 四类退出码、错误 token 与控制面不可达。
- `tests/web.test.ts`：`/api/board`、`/api/*` 请求头与 cookie 鉴权、`/ui` 关闭时的 404、`/health`。
- `tests/telegram.test.ts`：菜单随 `COMMANDS` 增加 `retry`。

## 文档

更新 `docs/specs/014-agent-cli`（CLI 改为客户端、退出码表）、`docs/specs/015-web-console`（控制面常驻）、`docs/specs/018-health-metrics`（`/api/state` 与执行器）、`docs/usage.md`、`docs/operations.md`、`docs/architecture.md`、`README.md`、`skills/pisa/*`、`CHANGELOG.md`。
