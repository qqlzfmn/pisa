# 017 · 任务

## 规格

- [x] T001 `docs/specs/017-trigger-thread/spec.md`、`plan.md`：问题证据、需求、验收、取舍（FR-001…FR-009）

## 实现

- [x] T002 `src/trigger.ts`：`makeTrigger` 生成身份与载荷指纹，`payloadHash` 归一正文，`threadKeyOf` 解析线程（FR-001/FR-005）
- [x] T003 `src/store.ts`：`triggers` 表与索引、`triggerByMessage`、`createTaskFromTrigger`（含编辑判定）、`attachThreadNote`、`updatePrompt`、旧库补齐；删除 `taskByEvent`、`insertTaskOnce`（FR-001/FR-002/FR-003/FR-006）
- [x] T004 `src/router.ts`：线程解析、触发器去重、编辑挂回原任务并更新排队正文、同线程无命令消息并进上下文（FR-002/FR-003/FR-004/FR-008/FR-010）
- [x] T005 `src/cli.ts`、`src/web.ts`：改走触发器 API，`--event-id` 与 Web 控制台取回任务号行为不变（FR-007）
- [x] T006 `src/channels/telegram.ts`：`edited_message`、论坛话题线程、版本与 actor（FR-005/FR-009）
- [x] T007 `src/github-watcher.ts`、`src/github.ts`：评论 `updated_at` 作版本，线程为 `github:<repo>:issue:<n>`，actor 为评论作者（FR-005/FR-009）
- [x] T008 `src/index.ts`：webhook 接受可选 `threadKey` / `version`（FR-005）

## 测试

- [x] T009 `tests/trigger-thread.test.ts`：重复投递 1 个任务与 1 行触发器、两个线程 2 个任务、v1→v2 编辑、已开跑任务编辑只留痕、旧库补齐与重放、回复续跑线程、CLI 幂等、GitHub 评论编辑不新建任务
      验证：先跑出失败（红），实现后全绿；删除去重或编辑分支时对应用例失败
- [x] T010 既有用例回归：`bun test`、`bunx tsc --noEmit`

## 文档

- [x] T011 `docs/architecture.md` 4.2 触发源契约改为线程/消息/版本/载荷；`CHANGELOG.md` 记录变更；`docs/operations.md` 补 webhook 新字段

## 验收

- [x] T012 复现场景实跑：同一消息编辑后再投递，任务正文为新版本且任务数不变（spec §5）
- [x] T013 `bun test` 与 `bunx tsc --noEmit` 通过

## security-5：事件号归属

- [x] T014 `src/webhook.ts`：webhook 入口独立成模块，顺序为 token 常量时间比较（403）→ `Content-Length` / 正文 64 KiB（413）→ `prompt`（400）→ `eventId` 前缀（400）→ `router.handle`；省略 `eventId` 自动生成 `webhook:<ts>:<rand>`（FR-011/FR-013）
- [x] T015 `src/http.ts`：`MAX_BODY_BYTES`、`HttpError`、`safeEqual`、`readJson` 抽出共用，`src/web.ts` 删掉重复实现（FR-013）
- [x] T016 `src/router.ts`：`claimEvent` 移到鉴权与正文校验之后、`createTaskFromTrigger` 之前，返回值不拦截建任务（FR-012）
- [x] T017 `tests/webhook.test.ts`：token 缺失/等长错值/短值 403、`cron:`/`github:comment:`/`telegram:`/无前缀 400 且 `events` 无键、合法事件号建任务并回执、重投只建一个、省略事件号自动生成、伪造 `Content-Length` 与超限正文 413、非 POST 405
- [x] T018 `tests/router.test.ts`：非白名单投递 `eventId` 被拒后，白名单同 `eventId` 建任务且 `events` 只一行
- [x] T019 `README.md`、`docs/operations.md`、`docs/architecture.md` 补命名空间与错误码说明；`CHANGELOG.md` 记录

## 版本重放：旧版本不能倒退需求

- [x] T020 `src/trigger.ts`：`compareVersion` 纯数字按数值、其余按字典序，空版本不参与排序（FR-004）
- [x] T021 `src/store.ts`：去重按触发器 `id` 是否已登记判断；`latestVersion` 识别迟到的未登记旧版本，只留痕不改正文；`TriggerClaim` 增加 `stale`（FR-003）
- [x] T022 `src/router.ts`、`src/cli.ts`：迟到旧版本的回执说明「已有更新版本，只做了留痕」（FR-007）
- [x] T023 `tests/trigger-thread.test.ts`：v1 → v2 后重投 v1 正文保持 v2 且 `triggers` 仍 2 行、v1 → v3 后到达 v2 只留痕、版本数值/字典序比较
      验证：重放与迟到用例在旧实现上正文退回旧版本（红，见复现记录），改后保持最新版本（绿）
- [x] T024 `docs/architecture.md` 4.2、`CHANGELOG.md` 同步规则与修复说明
