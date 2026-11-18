# 021 · 任务

- [x] T1 `Store`：`executorPaused()` / `setExecutorPaused()`
- [x] T2 `Router`：`fill()` 尊重暂停；`retry` 命令；`planRewindFor()` / `activeCount()`
- [x] T3 抽出 `ReplyBus`、`tailLog`、本机动作链路（`manager.ts`）
- [x] T4 `src/api.ts`：鉴权、`/state`、`/tickets/:id`、`stop|retry|merge|rewind`、`/executor/pause|resume`
- [x] T5 `index.ts`：管理接口随 Web 服务常驻，写 `api.json`
- [x] T6 CLI：新退出码、HTTP 客户端、`run|pause|stop|retry`，`status|show|logs|merge|rewind --json`
- [x] T7 测试：鉴权矩阵、接口契约、暂停、重试、退出码
- [x] T8 文档：operations、architecture、skills/pisa、CHANGELOG、014/015/017 规格交叉引用
