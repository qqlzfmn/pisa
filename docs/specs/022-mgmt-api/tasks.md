# 022 · 任务清单

- [x] T1 规格：接口、命令映射、退出码（`spec.md`）
- [x] T2 `GET /api/state`：看板文本、计数、24h 指标、执行器状态
- [x] T3 `GET /api/repos`
- [x] T4 `GET /api/tasks` 的 `status`/`limit`/`pr`/`githubRepo` 与平铺 `tasks`
- [x] T5 `GET /api/tasks/:id?tail=`
- [x] T6 `POST /api/tasks/:id/retry`（continue 语义、状态分流、审计）
- [x] T7 `POST /api/executor/pause` 与 `Router` 暂停开关
- [x] T8 `?token=` 只对 `/ui` 与 `/` 生效
- [x] T9 `src/mgmt.ts`：token 头、超时、错误分类
- [x] T10 `src/cli.ts`：`run`/`continue` 本地入队，其余走 API
- [x] T11 退出码 0/1/2/3 与 help 文案
- [x] T12 `tests/web.test.ts`：机器接口与越权
- [x] T13 `tests/cli.test.ts`：真实 HTTP 下的命令与退出码
- [x] T14 `docs/operations.md`、`docs/usage.md`、`skills/pisa/`、`CHANGELOG.md`
