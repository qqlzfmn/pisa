# 020 · Web 控制台 Phase 2：撤销预览、配置与定时任务编辑、趋势图表

- 状态：implemented
- 关联：`docs/specs/015-web-console/`（Phase 1 的看板、派活、取消/合并）
- 依赖：013 rewind（计划与执行）、009 scheduler（cron 校验）、adapters（可选的 worker.adapter）

## 1. 问题

Phase 1 解决了「看任务、派活、取消、合并」。日常维护仍有三处要离开页面：

1. 撤销只能在聊天里先出计划、再带 `--yes` 重发，页面上看不到会删哪些分支、开过哪些 PR、失败后是否可重试
2. `repos`、`worker`、`schedules` 只能手改 `pisa.config.json` 再重启，改动是否合法要靠进程启动时才发现
3. 没有历史趋势：成功率、耗时分位、排队深度只能看当前 24h 快照

## 2. 目标

- 页面上预览撤销计划，再决定是否执行
- 页面上编辑仓库、worker、定时任务，保存前校验，保存后提示重启生效
- 用图表看最近 1–30 天的成功率、P50/P95 耗时与排队深度
- 所有写操作二次确认，并留下追加写的审计记录
- 配置校验与写操作有自动化测试

## 3. 用户故事

### US-1 撤销前先看清

作为所有者，我在终态任务详情里点「撤销」，先看到合并状态、将删的分支/引用/PR/记录和不可撤销项，再点「执行撤销」。页面提交时带 `confirm: true`，等价于 `rewind --yes`。

### US-2 改配置不手抖

作为所有者，我在配置区增删仓库、改 adapter/命令/并发/超时、增删定时任务；点保存时先得到全部错误（一次列全，不是逐条试错），合法才落盘。页面提示「重启守护进程后生效」。

### US-3 看趋势

作为所有者，我选 7/14/30 天，看到每日完成数、成功率、P50/P95 耗时和排队深度曲线；没有数据的日子保留空桶。

### US-4 事后追溯

作为所有者，我在页面查看最近的写操作：谁、什么时候、对什么、成功与否。记录追加写入 `.pisa/audit.log`。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `GET /api/tasks/<id>/rewind` 返回撤销计划（只读）：`taskId`、`status`、`merge` 与中文 `mergeLabel`、`actions`（`kind`/`label`）、`irreversible`、`notes`、`executable`；任务不存在 404，已撤销/排队/运行/暂停返回 409 并提示先取消 |
| FR-002 | `POST /api/tasks/<id>/rewind` 与聊天一致：先计划、后执行；请求体必须带 `confirm: true`，否则 400；成功以任务状态 `rewound` 判断 |
| FR-003 | `GET /api/config` 返回可编辑视图 `{repos, worker, schedules}`、配置文件绝对路径与可用 adapter 列表；仓库的「允许派活」映射 `whitelist.repos` |
| FR-004 | `POST /api/config` 校验失败返回 400 与全部错误；成功原子写回配置文件，保留未编辑的键，响应 `restartRequired: true` |
| FR-005 | 校验规则：别名格式与唯一；仓库路径是已存在目录；adapter 在注册表内；`timeoutSec` 1–86400；`concurrency` 1–32；cron 为 5 段；定时任务的仓库必须在提交的 repos 中；id 与仓库别名同规则且唯一 |
| FR-006 | `GET /api/stats?days=1..30` 返回按本地日分桶的 `finished`/`succeeded`/`failed`/`successRate`/`p50Ms`/`p95Ms` 与队列深度采样；缺省 7 天，越界夹取 |
| FR-007 | `GET /api/audit?limit=1..200` 返回最近的写操作记录，最新在前 |
| FR-008 | 所有写操作（派活、取消、合并、撤销、保存配置）要求 `confirm: true`，缺失返回 400；成功后写审计（时间、操作者、动作、目标、结果、摘要） |
| FR-009 | 审计落 `.pisa/audit.log`，JSONL，敏感值按 `log.redact` 脱敏，单文件超过 5 MiB 轮转为 `.1` |
| FR-010 | 页面提供配置表单、提交前确认、错误汇总与重启提示；审计表格；撤销预览与执行按钮；成功率/耗时/队列图表 |

## 5. 验收

1. 对已成功任务 `GET /api/tasks/<id>/rewind` → 200，计划字段完整；运行中任务 → 409
2. 不带 `confirm` 的撤销/保存配置 → 400，任务状态与文件不变
3. 保存非法配置 → 400 一次列出多类错误，配置文件不被创建/覆盖；保存合法配置 → 其他键保留、`whitelist.repos` 同步、提示重启
4. `GET /api/stats?days=7` → 7 个日桶与队列点；`days=999` 夹到 30
5. 派活、保存配置后 `GET /api/audit` → 最新在前，包含动作、目标与结果
6. 页面走查：预览撤销、保存配置、确认框、图表、审计表均可见可用
7. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 在页面重启守护进程或热加载配置
- 多用户权限、审计防篡改或导出
- 任意 JSON 编辑（只暴露 repos/worker/schedules）
- 撤销单个动作的选择性撤销
