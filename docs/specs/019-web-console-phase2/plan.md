# 019 · 实施计划

## D1 撤销：Router 抽出 `previewRewind` / `executeRewind`，IM 与 Web 共用

现状 `handleRewind` 把「权限、状态、仓库」检查、计划、执行、回复揉在一个方法里，Web 只能拼 IM 文本再解析回复，脆且重复。

- `previewRewind(id, actor)`：检查 + `planRewind`，返回计划或拒绝原因
- `executeRewind(id, actor)`：调用 `previewRewind`，有动作则 `applyRewind`、按成功项 `removeEffect`，`merge !== "unknown"` 时 `store.transition(id, "rewound")`；返回计划、结果与回执文本
- `handleRewind` 变薄壳：解析参数 → 未带 `--yes` 回 `formatRewindPlan`，带了调 `executeRewind` 回回执

`actor = { admin, userId }` 显式传入，替代原先直接读 `msg`。Web 侧 `admin: true`、`userId: cfg.web.userId`，与 Phase 1 的已认证操作者语义一致。

## D2 配置：新增 `src/config-file.ts`，只投影可编辑子集

```ts
interface ConfigDraft {
  repos: Array<{ alias; path; remote?; baseBranch? }>;
  worker: { adapter; command; concurrency; timeoutSec; idleTimeoutSec };
  schedules: ScheduleJob[];
}
configDraft(cfg)                 // 生效配置 → 草稿（字段补齐默认值）
draftFromFile(path)              // 用 loadConfig 读文件 → 草稿 / 解析错误
validateDraft(unknown)           // HTTP 入参 → 草稿 / 错误清单
writeConfigPatch(path, draft)    // 只回写受管字段
sameDraft(a, b)                  // pendingRestart 判定
```

关键决定：

- **「重启后会生效的值」用 `loadConfig(path)` 求**：路径解析、默认值合并、环境变量覆盖与真实启动完全一致，避免第二套语义。文件缺失/解析失败时退回当前生效值并附错误。
- **只回写受管字段**：读原 JSON 对象，替换 `repos` / `worker` 的五个字段 / `schedules`，其余键保留。`worker` 用浅合并，不覆盖 `extraArgs`、`envAllow`。
- **写前置校验**：`validateDraft` 是唯一入口，Web 直接返回它的错误列表；不合法时不碰文件。
- **原子写**：同目录临时文件 + `rename`，避免半截 JSON。
- 仓库路径在草稿中一律是绝对路径（`loadConfig` 已解析），保存写回绝对路径，语义不变。

## D3 指标：`bucketMetrics` 纯函数 + 队列采样表

- `metrics.ts` 增加 `MetricBucket` 与 `bucketMetrics(tasks, samples, from, to, buckets)`：等宽分桶，任务按 `endedAt ?? createdAt` 归桶（与 `finishedBetween` 同口径），成功率/分位复用 `computeWindowMetrics`；样本按 `at` 归桶，取均值与峰值。
- `store.ts` 增加 `queue_samples(at PRIMARY KEY, queued, running)` 与 `sampleQueue` / `queueSamples`。采样写库时顺手删除 7 天前的行，保留策略与 `retention.ts` 解耦（那里按月清理任务数据，语义不同）。
- `Router.start()` 的 800ms tick 里每 60 秒采一次：`store.countByStatus()` 的 `queued` 与 `running`。启动即采一次，图表第一分钟就有点。
- `/api/metrics` 的 `hours` 夹到 1–168、`buckets` 夹到 6–96，非法输入不报错，取默认值 24/24。

## D4 审计：`audit` 表 + 写操作统一记账

- 表 `audit(id AUTOINCREMENT, at, action, target, detail, actor)`，按 `id DESC` 查询。
- 每次插入后删除超出最近 5000 条的行；不做按月清理，量级天然有界。
- `web.ts` 里所有写操作（派活、取消、合并、撤销、配置保存）在拿到结果后记一条：`target` 是任务号或配置文件路径，`detail` 是回执文本或错误，`actor` 是 `web.userId`。
- IM 路径不记审计：IM 的写操作已有会话上下文，审计的用途是补上「页面操作没有聊天记录」这一缺口。

## D5 Web 路由

- `TASK_ROUTE` 扩为 `^/api/tasks/([\w-]+)(?:/(cancel|merge|rewind))?$`；`rewind` 支持 GET（预览）与 POST（执行），`cancel`/`merge` 仍是 POST。其它组合返回 405。
- 新增 `GET/POST /api/config`、`GET /api/metrics`、`GET /api/audit`。
- `WebDeps` 增加可选 `configPath`，默认 `resolve(PISA_CONFIG ?? "pisa.config.json")`；`index.ts` 显式传入同一路径解析结果，测试用临时文件。
- 计划 JSON 在 `rewind.ts` 增加 `rewindPlanJson(plan)`（含中文 `mergeLabel` 与动作 label），Web 不再自己拼标签。

## D6 页面

- 指标区：三张 SVG。成功率用柱（0–100%），耗时用柱（自适应最大值，`formatDuration` 标尺），队列深度用折线（均值实线、峰值虚线）。所有节点 `createElementNS`，`<title>` 提供逐桶提示，横轴首尾时间用文本节点。
- 配置区：仓库与定时任务用表格行编辑（每行一组 input，删除按钮），Worker 五个字段用 input；「保存」→ 浏览器确认 → `POST /api/config`；响应错误逐条显示，成功后重载配置区并提示重启。附「恢复为当前生效值」。
- 详情面板：终态任务出现「撤销预览」，渲染合并状态、动作清单、不可逆项、备注；「确认撤销」执行后刷新详情与看板。
- 审计区：最近 20 条表格，随看板刷新一起拉取。
- 自动刷新保留 5 秒；配置表单有未保存修改时暂停自动重渲染（用 `dirty` 标志），避免输入被覆盖。

## 测试

`tests/web-config.test.ts`（新）：

- `validateDraft`：合法草稿归一化；重复别名、非法别名、空路径、并发 0/1.5/33、超时越界、重复任务 id、坏 cron、空 prompt、未知 repo 各自报错
- `writeConfigPatch`：只改受管字段（`trigger`/`web`/`worker.extraArgs` 保留）；非法 JSON 拒绝；原子替换后文件可解析
- `GET/POST /api/config`：`pendingRestart` 变化、缺 `confirm` 400、非法草稿 400 且文件不变、成功后审计有记录

`tests/web.test.ts`（扩）：

- 撤销：预览返回动作且状态不变；POST 缺 `confirm` 400；带 `confirm` 后分支被删、任务 `rewound`、审计有 `rewind`
- 指标：`/api/metrics` 桶数与聚合、非法参数回落默认
- 审计：派活/取消/合并后 `/api/audit` 能查到

验证：`bun test`、`bunx tsc --noEmit`；再用临时配置起真实服务，走「预览撤销 → 执行 → 改配置 → 指标」一遍。
