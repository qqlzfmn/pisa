# 019 · Web 控制台 Phase 2：撤销入口、配置编辑、指标趋势与审计

- 状态：specified
- 关联：015-web-console（Phase 1 的鉴权、看板与写操作路径）、013-rewind（撤销计划与执行）、018-health-metrics（指标口径）、009-scheduler（定时任务语义）

## 1. 问题

Phase 1 解决了「看和操作」，但剩下三类日常动作仍要离开页面：

- 撤销任务只有 `/pisa rewind <任务号> [--yes]` 一条路：先发命令看计划，再发一次带 `--yes` 的命令执行，且不记得要看哪几项
- 配置（仓库、Worker 并发与超时、定时任务）只能手改 `pisa.config.json` 再重启；手改时拼错别名或 cron，只有重启后才暴露
- 成功率、耗时只有 `/health` 的 24h 单点数字，看不到「今天下午开始变慢」这类趋势；队列是否堆积也没有历史

同时，页面上已有的写操作（派活、取消、合并）与新的撤销、配置保存都没有留痕，事后无法确认谁在何时改了什么。

## 2. 目标

- 页面上撤销任务：先看计划（要删的分支/工作副本、要关的 PR、不可逆项），确认后执行
- 页面上编辑仓库、Worker 并发与超时、定时任务；保存前由服务端校验，写回配置文件，并明确说明「重启生效」
- 成功率、耗时（p50）、队列深度按时间分桶的图表，窗口可选
- 所有写操作二次确认并写审计日志，页面可查最近记录
- 保持单页、无前端框架、无构建步骤

## 3. 用户故事

### US-1 撤销前审阅计划

作为 pisa 的所有者，我在任务详情里点「撤销预览」，看到撤销会删除哪些分支、关闭哪些 PR、丢弃哪个工作副本，以及哪些操作不可逆。

### US-2 执行撤销

作为所有者，我在确认预览内容后执行撤销；任务随后变为已撤销，副作用账本同步清理，结果与 `/pisa rewind --yes` 完全一致。

### US-3 编辑配置

作为所有者，我在页面上改仓库列表、Worker 并发/超时、定时任务，保存时被拦下不合法的输入（重复别名、坏 cron、越界并发），保存成功后页面提示重启生效。

### US-4 看趋势

作为所有者，我选择时间窗口，看到成功率、p50 耗时、队列深度的分桶图表，判断是变慢还是任务变多。

### US-5 查审计

作为所有者，我在页面上看到最近的写操作记录：时间、动作、目标、说明、操作者。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `GET /api/tasks/<id>/rewind` 返回撤销计划：`taskId`、`merge`、`mergeLabel`、`actions[{kind,label}]`、`irreversible`、`notes`；不存在 404；排队/执行中/暂停的任务返回 409 与原因 |
| FR-002 | 预览是只读的：不改变任务状态、不写副作用账本、不动分支与 PR |
| FR-003 | `POST /api/tasks/<id>/rewind` 必须带 `confirm: true`，否则 400；执行路径与 `/pisa rewind <id> --yes` 相同（同一份计划、同一套动作与状态跃迁）；返回 `{ok, message, actions}`，没有可执行动作时只把任务标为已撤销 |
| FR-004 | `GET /api/config` 返回 `{path, draft, active, pendingRestart, errors}`；`draft` 是「重启后会生效」的可编辑子集（仓库、Worker 并发与超时、定时任务），`active` 是当前进程使用的值；文件缺失或不可解析时 `draft` 退回 `active` 并给出 `errors` |
| FR-005 | `POST /api/config` 接收 `{confirm: true, draft}`；缺 `confirm` 400。服务端校验：至少一个仓库；别名非空、只含字母数字与 `_-`、不重复；路径非空；`concurrency` 为 1–32 的整数；`timeoutSec` / `idleTimeoutSec` 为 1–86400 的整数；定时任务 id 唯一、cron 可解析、prompt 非空、repo 必须是已配置别名。任一项不通过返回 400 与全部错误，文件不动 |
| FR-006 | 保存只回写受管字段：`repos`、`worker` 的 `adapter`/`command`/`concurrency`/`timeoutSec`/`idleTimeoutSec`、`schedules`；文件中的其它键（`trigger`、`whitelist`、`web` 等）原样保留；写入采用临时文件 + rename 原子替换 |
| FR-007 | 保存成功后响应带 `restartRequired: true` 与提示文本；随后 `GET /api/config` 的 `pendingRestart` 为 `true`，直到进程重启 |
| FR-008 | `GET /api/metrics?hours=<1-168>&buckets=<6-96>` 返回等宽时间桶：每桶 `from`、`finished`、`succeeded`、`failed`、`successRate`、`p50Ms`、`p95Ms`、`queueAvg`、`queueMax`、`runningAvg`；样本口径与 018 一致（只有成功/失败计入成功率与耗时） |
| FR-009 | 队列深度每分钟采样一次（排队数、执行中数），保留 7 天；趋势图与健康检查使用同一份任务表 |
| FR-010 | 审计：派活、取消、合并、撤销、配置保存每次尝试都写一条 `{at, action, target, detail, actor}`；失败的尝试也记录结果；审计只保留最近 5000 条 |
| FR-011 | `GET /api/audit?limit=<1-200>` 返回最近的审计行，新的在前 |
| FR-012 | 页面新增三块：指标区（成功率、p50 耗时、队列深度三张图）、配置区（仓库表格、Worker 字段、定时任务表格，可增删行）、审计区；任务详情出现「撤销预览」，预览成功后出现「确认撤销」 |
| FR-013 | 配置保存、撤销执行、派活、取消、合并都在浏览器里二次确认 |
| FR-014 | 页面继续用 `createElement` + `textContent` 构造文本；图表用 `createElementNS` 画 SVG，外部数据不经过 `innerHTML` |

## 5. 验收

1. 对有分支副作用的任务：`GET /api/tasks/<id>/rewind` 返回 `actions` 且任务状态不变；`POST` 不带 `confirm` → 400；带 `confirm: true` → 分支被删、任务 `rewound`、`GET /api/audit` 出现 `rewind` 行
2. `GET /api/config` 的 `pendingRestart` 为 `false`；`POST` 把 `concurrency` 改成 3 → 文件里 `worker.concurrency` 为 3、其它键保留、响应 `restartRequired: true`；再 `GET` 时 `pendingRestart` 为 `true`
3. `POST /api/config` 提交并发 0、重复别名、坏 cron 三种草稿 → 均 400 且文件字节不变
4. `GET /api/metrics?hours=24&buckets=12` 返回 12 个桶，桶内成功率与任务表中的成功/失败数一致，队列深度来自采样
5. `GET /api/audit` 依次出现派活、取消、合并、撤销、配置保存的记录
6. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 配置热加载；保存后仍需重启进程
- 编辑白名单、通道、webhook、GitHub 监听的敏感段
- 实时推送（SSE/WebSocket）、图表库、导出、告警阈值
- 审计的删除、清空、按时间范围检索
- 撤销的批量操作与计划调整（例如保留某个分支）
