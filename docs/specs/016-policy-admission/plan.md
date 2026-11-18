# 016 · 实施计划

## D1 新模块 `src/policy.ts`，纯函数无状态

判定、版本、展示、校验四处逻辑集中在一处，Router/CLI/Web 只调用（FR-001、FR-003、FR-006）。不新建类：策略没有运行时状态，全部输入来自 `Config`。

导出面：

- `DEFAULT_SOURCE_POLICY`、`KNOWN_SOURCES`：来源默认值与展示顺序
- `resolvePolicy(policy, source)`：单来源解析（补默认 + 深合并）
- `admit(cfg, {source, listed, mentioned})`：返回 `{admitted, execute, mode, cell, reason}`
- `policyVersion(cfg)`、`formatPolicy(cfg)`、`policyWarnings(policy)`

## D2 判定顺序：allowed → 准入格 → accept

先判来源是否开放，再判四个准入格，最后看接单模式（FR-001、FR-008）。`observe` 的语义是「接单但不执行」：`admitted: true, execute: false`，Router 据此只回执不建任务。

拒绝原因以「无权限」开头，因为 `src/web.ts` 用该前缀判定请求失败；观察模式的原因不带该前缀（它不是拒绝）。

## D3 配置形状：`policy?: Record<来源, 部分策略>`

来源是开放字符串（渠道名由 `channels` 决定），用 `Record<string, …>` 而不是穷举联合，未知来源自然可配。字段缺省时回落到来源默认值，深合并只到 `admission` 两层，不做无限递归合并。

CLI 的默认值与其它来源不同（名单内外都放行）：CLI 直接写库、不经 Router，运行者本来就有完整权限；若默认收紧，现有 `pisa task` 用法与测试全部失效，且与 `skills/pisa/references/limits.md` 的定位矛盾（FR-002）。

## D4 策略版本 = 影响准入的输入的白名单用户 + 全表解析结果的哈希

取 `sha256(JSON(白名单用户排序, KNOWN + 已配置来源的 resolvePolicy 结果))` 前 12 位（FR-003、FR-005）。

不含仓库白名单、路径、worker 配置：那些变化不改变「谁能从哪派活」，进哈希会让版本无意义地抖动。排序保证同一策略的版本稳定，配置书写顺序变化不算变更。

## D5 存储：`mandate TEXT` + `policy_version TEXT`

`tasks` 表加两列，构造器按现有轻迁移模式补列；mandate 存 JSON（`{source, listed, mentioned, cell, mode}`），不拆五列：它整体读取、整体展示，拆列只增加同步成本。解析失败按缺失处理——缺凭据不应让任务读不出来（FR-003）。

mandate 建单后不可变，不进 `transition` 的 patch 映射。

## D6 Router：`claimEvent` 之后判定，拒绝与观察共用节流

判定放在 `claimEvent` 之后：事件幂等先去重，重复投递不产生第二条「无权限」回执。拒绝与观察共用现有 `deniedAt` 24 小时节流，避免观察模式刷屏（FR-001、FR-002）。

`handleResume` 的判定插在原请求者检查之后、工作副本检查之前：先确认「谁能恢复」，再谈能不能恢复（FR-005）。回执同时给建单版本与当前版本。

已建立的队列任务不复查策略——`fill()` 取出即执行（FR-004）。

## D7 CLI 走同一判定

`pisa task` / `pisa continue` 建单前调用 `admit`，拒绝抛 `UsageError`（退出码 2），不静默建单（FR-001、FR-002）。CLI 的「点名」恒为 true：命令行是本机人工或脚本的显式动作。

## D8 测试分层

- `tests/policy.test.ts`：纯函数——默认值、四格判定、allowed 关闭、off/observe、版本稳定性与变更、非法配置告警、`formatPolicy` 内容
- `tests/router.test.ts`：越权拒绝、点名放开后接单并记录 mandate/版本、观察模式不建任务、改配置后已排队任务仍执行、降权后恢复被拒且保持暂停、`/pisa policy` 展示与权限
- `tests/proactive.test.ts`：关键词路径按「未点名」判定
- `tests/cli.test.ts`：`accept: "off"` 时 `pisa task` 拒绝并退出码 2

不引入新依赖；版本哈希用 `node:crypto`。
