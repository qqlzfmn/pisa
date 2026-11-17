# 014 · 管理 API 与 pisa CLI

- 状态：implemented
- 关联：001（任务状态机）、010（任务看板）、013（rewind）、`webhook` 事件入口
- 依赖：无新增运行时依赖

## 1. 问题

现在只有两种方式驱动 pisa：

- IM 命令：给人用，输出是给人读的自然语言，脚本拿不到结构化结果
- webhook：只能投递新任务，不能查询、停止、重试、合并、撤销

脚本和 agent 想读状态只能直接打开 `.pisa/pisa.db` 查 `tasks` 表，等于把内部表结构当成对外契约；想停止任务只能去杀进程。CLI 目前只是 stdin/stdout 交互壳，没有任何可脚本化的子命令。

## 2. 目标

- 一套本地 HTTP 接口覆盖状态查询与任务操作，IM、CLI、脚本共用同一实现
- CLI 提供 `status` / `run` / `logs` / `merge` / `rewind`，默认给人看，`--json` 给脚本
- 退出码能区分「成功」「需要重启」「部件错误」「待配置」，脚本不需要解析文本
- 接口只对本机回环地址开放，请求头鉴权

## 3. 用户故事

### US-1 脚本读状态

作为运维脚本，我执行 `pisa status --json`，拿到运行中、排队、最近完成与各状态计数，不碰 SQLite。

### US-2 脚本派活

作为 CI 或 agent，我执行 `pisa run "跑测试并修掉失败" --repo pisa --json`，拿到任务号，后续用它查日志与结果。

### US-3 查单个任务

作为排障的人，我执行 `pisa logs t_x --json` 或请求 `GET /tickets/t_x`，看到任务字段、副作用账本和日志，不需要 SSH 进机器翻文件。

### US-4 运维操作

作为维护者，我用 `POST /tickets/:id/retry` 重跑失败任务、`POST /tickets/:id/stop` 停止任务、`POST /executor/pause` 暂时不接新任务。

### US-5 合并与撤销

作为维护者，我用 `pisa merge t_x` 与 `pisa rewind t_x --yes` 完成原来只能通过 IM 做的操作，结果可被脚本判断。

### US-6 退出码

作为脚本作者，我按退出码分支：`0` 正常、`1` 需重启、`2` 部件错误、`3` 待配置；不需要解析输出文本。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 管理接口只监听 `127.0.0.1`；请求 URL 的主机名不是回环地址（`127.0.0.1` / `localhost` / `[::1]`）时返回 403 |
| FR-002 | 所有管理请求必须带 `x-pisa-token`，与配置的 token 不一致或缺省时返回 403；鉴权先于路由与数据读取 |
| FR-003 | `GET /state` 返回 `{ paused, counts, running, queued, finished }`；`finished` 为最近 5 条终态任务，任务对象字段与 `Task` 一致 |
| FR-004 | `GET /tickets/:id` 返回 `{ ticket, effects }`；未知任务返回 404 |
| FR-005 | `POST /tickets` 接受 `{ prompt, repo? }`，创建排队任务并返回 `{ ticket }`；`prompt` 缺失返回 400；仓库未配置或不在仓库白名单返回 400 |
| FR-006 | `POST /tickets/:id/retry` 只允许 `failed` / `cancelled` → `queued`，同时清空 `started_at`、`ended_at`、`error`、`cancel_requested`；其它状态返回 409 |
| FR-007 | `POST /tickets/:id/stop`：`queued` / `paused` 立即转 `cancelled`；`running` 置取消标记（响应 `cancelling: true`）；终态返回 409；未知任务 404 |
| FR-008 | `POST /executor/pause` 与 `POST /executor/resume` 切换调度开关；暂停期间不再取新的排队任务，运行中的任务不被打断 |
| FR-009 | `GET /tickets/:id/logs` 返回 `{ entries }`，每项含 `ts` / `stage` / `msg`；任务存在但没有日志文件时返回空数组 |
| FR-010 | `POST /tickets/:id/merge` 与 IM 的 `merge` 共用同一实现，返回 `{ ok, text, needsRestart }`；成功合并且进程未在看护模式下运行时 `needsRestart` 为 true |
| FR-011 | `POST /tickets/:id/rewind` 接受 `{ yes?: boolean }`，与 IM 的 `rewind` 共用同一实现，返回 `{ ok, text }`；不带 `yes` 时只预览且 `ok` 为 true |
| FR-012 | CLI 子命令 `status` / `run <需求>` / `logs <任务号>` / `merge <任务号>` / `rewind <任务号> [--yes]`；`run` 支持 `--repo <别名>`；所有子命令支持 `--json`，此时 stdout 只有一行 JSON |
| FR-013 | CLI 只通过管理接口读写状态，不直接打开 SQLite 或读 `.pisa/` 下的运行数据 |
| FR-014 | 退出码：`0` 正常；`1` 操作成功但需重启进程生效；`2` 部件错误（接口不可达、HTTP 5xx、任务不存在、操作失败）；`3` 待配置（管理接口禁用、缺 token、token 被拒） |
| FR-015 | 配置新增 `mgmt { enabled, port, tokenEnv }`，默认 `{ enabled: true, port: 8800, tokenEnv: "PISA_MGMT_TOKEN" }`；token 缺失时服务不启动并告警，CLI 报 `3` |

## 5. 验收

1. `GET /state` 在暂停后返回 `paused: true`，恢复后为 `false`
2. `POST /tickets` 建出的任务进入 `queued`，`pisa run --json` 输出的 `ticket.id` 与库中一致
3. `retry` 让 `failed` 任务回到 `queued` 并清空错误；对 `succeeded` 返回 409
4. `stop` 让排队任务变 `cancelled`，对运行中任务返回 `cancelling: true`
5. `logs` 返回任务日志条目；未知任务返回 404
6. `merge` 成功且未在看护模式时 CLI 退出码为 `1`；非看护模式外的成功合并不再单独输出重启提示
7. 缺 token 时 CLI 退出码 `3`；接口不可达时 `2`；正常 `status` 为 `0`
8. 缺 token 或 token 错误的 HTTP 请求返回 403，且不返回任何任务数据
9. 主机名不是回环地址的请求返回 403
10. `bun test` 与 `tsc --noEmit` 通过

## 6. 非目标

- 远程访问、TLS、多用户权限模型；鉴权就是单一 token
- 分页、按仓库/请求者过滤、批量操作
- 替换 IM 通道；CLI 只覆盖脚本化场景
- 管理接口的 OpenAPI 文档生成
