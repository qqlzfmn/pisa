# Web 控制台 Phase 2：撤销、配置编辑、趋势

## 背景

Phase 1（`015-web-console`）解决"看和操作"：看板、详情、派活、取消、合并。日常维护仍有三处摩擦：

1. 撤销（rewind）只有在 IM 里发指令才可用，Web 上看不到会撤销什么。
2. 改仓库、worker 并发、定时任务必须手改 `pisa.config.json` 并重启进程，改错要等启动失败才发现。
3. 成功率、耗时、队列深度没有趋势，只能翻日志判断。

## 目标

- 撤销二段式：先预览要执行的远端/本地动作，再确认执行。
- 配置可视化编辑：`repos`、`worker`（adapter/command/并发/超时）、`schedules`，保存前校验，保存后明确提示重启生效。
- 趋势图：按小时的成功率、耗时（P50/P95）、队列深度与运行数。
- 所有写操作（派活、取消、合并、撤销、配置保存）二次确认并落审计日志。

## 非目标

- 配置热加载（保存后仍需重启）。
- 编辑 `web`、`scheduler`、`proactive`、`retention`、`githubWatcher` 等其他配置段（继续走文件）。
- 认证体系改造（沿用 Phase 1 的 token + cookie）。
- 前端框架、构建链。

## 功能需求

- FR-001 端点 `GET /api/metrics?hours=N` 返回小时桶：`start`、`finished`、`succeeded`、`failed`、`successRate`、`p50Ms`、`p95Ms`、`queueDepth`、`running`，以及整窗汇总 `summary`。`hours` 限制 1..168，默认 24。
- FR-002 桶按 `endedAt` 归桶；队列深度与运行数在桶起点采样，不推算历史瞬时值以外的信息。
- FR-003 端点 `GET /api/config` 返回可编辑投影：`repos`、`worker`（含只读的 `extraArgs`/`envAllow`）、`schedules`、`schedulerConfigured`、`path`。投影来自配置文件原始 JSON，不使用运行期锚定后的路径，避免把相对路径改写成绝对路径。
- FR-004 端点 `POST /api/config` 接受 `{ confirm: true, patch }`。校验失败返回 400 与 `errors` 数组，不落盘；校验通过原子写入，返回 `restartRequired: true` 与提示文案。
- FR-005 校验规则：`repos[].alias`、`schedules[].id` 匹配 `^[A-Za-z0-9_-]+$` 且唯一；`repos[].path` 与 `schedules[].prompt` 非空；`worker.adapter` 与 `worker.command` 非空；`worker.concurrency` 整数 1..64；`worker.timeoutSec` 整数 1..86400；`schedules[].cron` 必须能被调度器解析；`schedules[].repo` 必须属于提交的 `repos`。原文件 `whitelist.repos` 非空时同步为新别名列表；为空时保持原样，保存配置不会顺带放行任何仓库。
- FR-006 端点 `GET /api/tasks/:id/rewind` 返回撤销计划（`merge`、`actions`、`irreversible`、`notes`、`text`）；任务不存在、已撤销、未结束、仓库未配置时返回 409 与原因。
- FR-007 端点 `POST /api/tasks/:id/rewind` 接受 `{ confirm: true }`；执行时重新生成计划，避免使用过期计划。
- FR-008 `POST /api/tasks`、`POST /api/tasks/:id/cancel` 与既有 `merge` 一样要求 `confirm: true`，缺失返回 400。
- FR-009 每次写操作落审计：`<stateDir>/audit.log`，每行 JSON `{ts, actor, action, target, ok, detail}`，`action` ∈ `dispatch|cancel|merge|rewind|config.save`，`actor` 取 Web 用户 id。文件超过 1 MiB 轮转为 `audit.log.1`，只留一代。
- FR-010 端点 `GET /api/audit?limit=N` 返回最近 N 条（默认 50，上限 200），时间正序。
- FR-011 页面新增：趋势区（三张柱状图）、配置编辑区（表格增删行、保存前本地数值检查）、审计区（最近记录）、详情面板的撤销按钮。撤销走"预览 → confirm(文本) → 执行"。

## 验收

1. `bun test` 通过；`bunx tsc --noEmit` 无错误。
2. 配置校验单测覆盖：非法别名、重复别名、越界并发、非法 cron、未知仓库引用、合法 patch 通过。
3. Web 接口测试覆盖：缺 `confirm` 的写操作返回 400；配置保存写入文件且响应含 `restartRequired`；写操作在 `audit.log` 留痕；撤销预览与执行。
4. 指标历史单测覆盖桶对齐、成功率、P95、队列深度采样。
