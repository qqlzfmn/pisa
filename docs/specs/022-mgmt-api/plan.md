# 022 · 实施计划

## 结构

```
src/web.ts          管理接口路由：/api/state、/api/repos、/api/tasks 过滤、/api/tasks/:id/retry、/api/executor/pause
src/web-session.ts  Web 与 CLI 共用的写操作外壳：消息翻译、串行、回执、审计、retry 分流
src/mgmt.ts         管理 API 客户端：token 头、超时、错误分类（未配置/不可达/鉴权失败/HTTP 错误）
src/router.ts       执行器暂停开关（只停领取，不停运行中的任务）
src/cli.ts          命令表、四种退出码、本地建单 + 其余走 API
```

## 步骤与验证

1. **规格**：`spec.md` 定义接口、命令映射与退出码 —— 验证：验收清单与测试一一对应。
2. **API**：`/api/state`、`/api/repos`、`/api/tasks` 过滤、`?tail=`、`retry`、`executor/pause` —— 验证：`tests/web.test.ts` 的「机器接口」用例。
3. **客户端**：`mgmt.ts` 统一错误分类 —— 验证：CLI 测试里的四种退出码。
4. **CLI**：`status`/`list`/`show`/`logs`/`wait`/`cancel`/`retry`/`merge`/`rewind`/`executor`/`config` 改走 API；`run`/`continue` 保留本地入队 —— 验证：`tests/cli.test.ts` 起真实 `Bun.serve`，逐命令断言 JSON 与退出码。
5. **文档与 skill**：`docs/operations.md`、`docs/usage.md`、`skills/pisa/`、`CHANGELOG.md` —— 验证：`tests/docs-links.test.ts` 与人工核对命令名。
6. **冒烟**：真实守护进程 + 真实 CLI —— 验证：`pisa status`、`pisa run --wait`、`pisa config --set` 的退出码。

## 风险

- 守护进程与管理 API 同生共死：daemon 停 ⇒ `status` 退 2。这是有意的，避免 CLI 读到过期快照。
- 建单仍直连 SQLite：离线入队是既有契约；只在写队列时打开一次连接。
- `?token=` 收紧后，旧书签里的 `/api/*?token=` 会 401；`/ui?token=` 不受影响。
