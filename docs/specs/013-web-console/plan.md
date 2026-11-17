# 013 · 实施计划

## D1 页面内嵌在 daemon 进程

复用同一份 Router 与 Store：派活走 `Router.handle` 的完整链路（别名、鉴权、去重、误触防护），取消与合并复用同一套实现。

`bun run web` 用 `--web` 启动：没有 IM 通道（`WebChannel` 无内层通道），调度、Worker、GitHub 轮询、定时器照常运行，交互面只有网页。daemon 是否内置由 `web.enabled` 决定，默认开启。

理由：另起一个进程读同一个 SQLite 只能写库，执行与合并逻辑会分叉；单进程是唯一事实源。

## D2 鉴权：token 头或查询参数，不用 Cookie

- 三种取法：`Authorization: Bearer`、`x-pisa-token`、`?token=`。
- 只绑 `127.0.0.1`。
- 页面 HTML 由服务端把 token 注入成 JS 常量，后续 `fetch` 带 `x-pisa-token`。
- 没有 Cookie，就不存在浏览器自动带凭证的 CSRF 面；token 比较用 `timingSafeEqual`，长度不同直接判否。

token 解析顺序：环境变量 → `stateDir/web_token` → 生成并 0600 落盘。落盘让重启（含自举重启）后书签仍可用。

## D3 写操作复用 Router，WebChannel 隔离 IM 回执

- 把取消、合并从「回复通道」里抽出来：`Router.cancelTask` / `Router.mergeTask` 返回 `{ok, text}`，IM 的 `handle` 负责把 `text` 发出去，网页直接当响应体。
- 派活不易拆（要经过别名、待确认、去重），直接调 `Router.handle`。`WebChannel` 是装饰器：`chatId` 以 `web:` 开头的回执只进内存环形缓冲，不投给 Telegram；其余原样转发。
- `IncomingMessage.admin` 让网页写操作跳过「只有原请求者」校验；IM 不设该字段，行为不变。

## D4 只读数据以 Store 为唯一来源

`runningTasks` / `queuedTasks` / `recentFinished` / `countByStatus` 增加可选 `repo` 过滤，SQL 里筛，不在路由层过滤。新增 `taskBySource` 供派活后按事件 id 找回刚建的任务，避免把任务号当返回值透传。

耗时统一用 `formatDuration`（与 `/pisa status` 同一实现），在 API 层算好，页面不再复制时间格式。

## D5 日志尾部有界读

`readLogTail(stateDir, taskId, limit)`：以 128KB 为上限从文件尾读，丢弃被截断的首行，最多 200 行；每行按 `TaskLogger` 的 JSON 格式解析成 `{ts, stage, msg}`，解析失败按原始行返回。轮询不会随日志增长而变慢。

## D6 页面单文件

`src/ui.html`：内联 CSS 与原生 JS，无依赖、无构建。服务端读取文件并把 `__PISA_TOKEN__` 替换为 JSON 转义后的 token。

渲染全部走 `textContent`/`createElement`，任务正文不做 innerHTML，避免把 prompt 当标记执行。PR 链接只允许 `http(s)`。

轮询：看板 3 秒，详情打开时同步刷新日志。合并用 `confirm()` 二次确认。

## D7 合并沿用既有验证

`mergeTask` 保留原流程：临时 worktree → 有 `tests/` 就 `bun test` → 主干必须已检出 → `--ff-only` 合并 → 看护模式下退出进程。网页只消费结果文本，不复制 Git 逻辑。

## 验证

- `tests/web.test.ts`：鉴权（缺失/错误 token、两种头）、`/ui`、看板分组与仓库过滤、详情与日志尾部、404、派活（成功 / 空需求 / 未知仓库 / 命令词）、取消（排队 / 终态 409 / 跨请求者）、合并（成功 / 未完成 409）
- `tests/worker.test.ts`：后台子进程占着输出管道时，取消仍能在数秒内返回
- 真实启动：临时 stateDir + `--web`，curl `/ui`、`/api/tasks`、派活、取消、合并
- `bun test`、`bunx tsc --noEmit`

## D8 取消要连进程树一起杀

Worker 以独立进程组启动（`detached: true`），取消与超时按组发信号：

- 只杀直接子进程时，它派生的子进程仍持有 stdout/stderr 管道，`run()` 会一直等管道关闭，任务卡在「取消中」永远不到终态；冒烟复现过。
- 按组杀还能避免「已取消」之后仍有人在即将删除的工作副本里写文件。

`tests/worker.test.ts` 用「后台子进程占着管道」的脚本做回归。
