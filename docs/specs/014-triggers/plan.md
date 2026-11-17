# 014 · 实现计划

- 输入：`spec.md`
- 约束：不引入新依赖（`node:crypto` / `node:fs` 足够）；不改变现有入口与测试行为；签名必须基于原始请求体

## 1. 技术决策

| 决策 | 结论 | 依据 |
| --- | --- | --- |
| 配置 | `Config.triggers?: { enabled; port; host?; githubActions?; feishu?; files? }`，`Bun.serve` 与文件监听共用一个开关 | 与 `webhook` / `proactive` 一致：可选段，缺省不启用（FR-001/FR-002） |
| 接口 | `src/triggers/types.ts`：`TriggerAdapter { name; path; handshake; verify; normalize }`，`normalize` 返回 `{ ok, events }` 或 `{ ok:false, status, error }` | 校验与解析分开：`verify` 只看签名/时间窗，`normalize` 只做协议解析与过滤；错误走返回值不走异常，装配层不用 try/catch 包业务逻辑（FR-003/FR-012/FR-014） |
| 去重键 | `TriggerEvent { dedupeKey; message }`，`message.eventId = dedupeKey`；适配层**不**占位，只由 Router 的 `claimEvent` 占一次 | 009 的教训：同一 key 被占两次会让 Router 当成重复投递丢掉（FR-010/FR-011） |
| GitHub 签名 | `createHmac("sha256", secret)` + `timingSafeEqual`，比较 64 位 hex | 常量时间比较，避免长度差异抛错（FR-003） |
| GitHub 过滤 | 事件类型取 `x-github-event`；`workflow_run` + `action=completed` + `conclusions`/`repos`/`branches` 白名单 | 结论、仓库、分支三层过滤，都在建消息之前（FR-004） |
| 飞书签名 | `sha256(timestamp + nonce + encryptKey + body)`，与 `x-lark-signature` 常量时间比较；时间戳窗口 300 秒 | 官方 v2 事件订阅的签名算法；窗口挡住重放（FR-006） |
| 飞书握手 | `handshake` 在 `verify` 之前执行：`{"type":"url_verification"}` 直接回 `{"challenge"}`；可选的 `verificationTokenEnv` 校验 body 的 `token` | URL 校验请求不带业务事件，若先验签会导致平台无法完成验证（FR-007） |
| 飞书归一化 | `header.event_type === im.message.receive_v1`；`message_type === text`；`content` 二次 JSON 解析；`mentions` 非空视为被 @ | 飞书文本消息把正文放在 JSON 字符串里；提及占位符形如 `@_user_1`，正则剥离（FR-008） |
| 飞书白名单 | `users` 为 `open_id` 列表，非空才校验；群消息有 @ 时补 `${trigger} ` | open_id 是应用维度标识，比昵称稳定（FR-008/FR-015） |
| 文件监听 | `watch(dir, { recursive: true })` 目录、`watch(dirname(file))` 单文件；去抖合并；`sha256` 前 64KB…1MB 内容摘要进 `dedupeKey` | `recursive` 在 macOS/Linux 的 Node 20+ 都可用；内容摘要保证「同内容重写」键不变（FR-009/FR-011） |
| 文件消息 | `channel=files`，正文列路径 + `prompt`（缺省给操作指令），补触发词前缀 | 与系统类事件一致：`isDirect` + 触发词前缀，不依赖 `dmWithoutTrigger`（FR-009） |
| HTTP 分发 | `TriggerHub.receive(path, { headers, body })` 纯函数式入口，`Bun.serve` 只做方法/路径/体积检查后调用它 | 测试直接调 `receive`，不占端口不联网（测试策略） |
| 装配 | `buildTriggers` 读环境变量：缺失 `secretEnv` / `encryptKeyEnv` 时告警并跳过该适配器；没有任何可用来源时返回 null | 凭据缺失不该让进程起不来；与 `webhook` 的告警方式一致（FR-001/FR-014） |
| 鉴权 | 不在适配层复制权限：消息交给 Router，白名单、仓库校验、单英文词防误触全部沿用现有逻辑 | 单一真相源（FR-015） |

## 2. 影响面

- `src/config.ts`：`TriggersConfig` 及三个来源配置类型，`Config.triggers`
- `src/triggers/types.ts`（新）：`TriggerRequest` / `TriggerEvent` / `TriggerAdapter` / `TriggerSource` / `TriggerReply`
- `src/triggers/verify.ts`（新）：HMAC、SHA-256、常量时间比较、JSON 对象解析
- `src/triggers/github-actions.ts`（新）：`GithubActionsTrigger`
- `src/triggers/feishu.ts`（新）：`FeishuTrigger`
- `src/triggers/files.ts`（新）：`FileTrigger`
- `src/triggers/hub.ts`（新）：`TriggerHub`（HTTP 服务、路径分发、投递）
- `src/triggers/index.ts`（新）：`buildTriggers` 装配
- `src/index.ts`：启动/关停 TriggerHub
- `pisa.config.example.json`、`README.md`

## 3. 测试策略

`tests/triggers.test.ts`，全部本地假数据，不联网、不占端口（`receive` 直接调用）：

- 签名：用 `node:crypto` 在测试里生成正确签名；错误签名、缺失签名、过期时间戳分别断言 403 且没有投递
- 重复事件：同一事件投递两次 → 断言 `dedupeKey` 相同，并接真实 `Store` + `Router`（内存库、假通道、临时 git 仓库）只建一个任务
- 非法载荷：非 JSON、缺 `workflow_run.id`、飞书 `content` 非 JSON、缺 `message_id`、缺 `open_id` → 400，任务数不变
- 过滤：`ping`、非 `workflow_run`、`conclusion=success`、仓库/分支白名单、飞书非消息事件与非文本消息 → 200 且 0 个事件
- 飞书握手：challenge 原样返回；验证 token 不符 403
- 飞书群消息：有 `mentions` 时正文补触发词；无 @ 时保持原样
- 文件监听：真实临时目录写文件，等待去抖投递；同内容重写得到相同键；不存在路径只告警
- 装配：没有 `triggers` 配置时 `buildTriggers` 返回 null；启用但缺凭据时跳过并告警

## 4. 风险

- 飞书文档对「URL 校验是否带签名头」表述不一：实现上握手先于验签，并用可选的验证 token 兜底，避免启用时卡住
- `fs.watch` 的事件合并与平台实现有关：去抖窗口内合并、按内容摘要去重，漏一次也会在下一次写入时重新触发；测试用轮询等待而非固定 sleep
- `Bun.serve` 端口冲突会让进程启动失败：`triggers.port` 与 `webhook.port` 默认不同（8800 / 8799），装配时只在启用时启动
- GitHub Actions 的 `run_attempt` 重跑会产生新键：这是期望语义（重跑重开单），文档写明
