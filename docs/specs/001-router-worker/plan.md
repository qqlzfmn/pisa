# 001 · 技术方案（plan）

- 对应规格：[spec.md](./spec.md)
- 状态：approved（C-1 IM / C-2 自动 PR / C-3 仓库+用户，2026-11-17 确认）
- 原则：能不加依赖就不加；能用一个进程解决就不拆服务

## 1. 技术选型

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Bun 1.4 | 内置 TS、SQLite、测试，零构建步骤 |
| 语言 | TypeScript strict | 状态机与事件契约需要类型兜底 |
| 持久化 | `bun:sqlite` | 单文件、支持唯一索引做幂等、无需部署 |
| IM 接入 | Telegram Bot API（long polling） | 不需要公网回调地址；后续加飞书只需实现同一接口 |
| Worker | 子进程调用 `omp --mode=json -p` | pi 的现有能力，不重写 agent loop |
| Git | 系统 `git` + 可选 `gh` | 不引入库；PR 创建按托管平台适配 |
| 依赖 | 0 个第三方包 | 奥卡姆剃刀；升级面最小 |

## 2. 模块划分

```
src/
├── index.ts            装配：配置 → 存储 → 路由 → 通道
├── config.ts           读 pisa.config.json + 环境变量覆盖
├── types.ts            Task / TaskStatus / IncomingMessage / WorkerResult
├── store.ts            SQLite：任务表、事件去重表、状态跃迁
├── router.ts           触发判定 → 建任务 → 排队 → 派发 → 回执
├── worker.ts           构造 Worker 提示词、起子进程、流式日志、超时终止
├── deliver.ts          提交、推送、开 PR、生成回执
├── git.ts              工作副本创建/清理、diff 统计
├── channels/
│   ├── types.ts        ChannelAdapter 接口
│   ├── telegram.ts     long polling + 发送
│   └── cli.ts          本地测试通道（stdin/stdout）
└── log.ts              结构化日志（JSONL，任务号贯穿）
```

依赖方向：`channels → router → worker/deliver → git/store`，反向不依赖。

## 3. 数据模型

```sql
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,          -- t_20261117_ab12cd
  source       TEXT NOT NULL,             -- telegram:7355434308:6582
  channel      TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  requester    TEXT NOT NULL,
  repo         TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  status       TEXT NOT NULL,             -- queued|running|succeeded|failed|cancelled
  branch       TEXT,
  pr_url       TEXT,
  summary      TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  ended_at     INTEGER
);

CREATE TABLE events (
  event_id   TEXT PRIMARY KEY,            -- 通道内唯一，用于幂等
  task_id    TEXT NOT NULL,
  seen_at    INTEGER NOT NULL
);
```

状态跃迁只允许：`queued→running`、`running→succeeded|failed|cancelled`、`queued→cancelled`。集中在一个函数里校验，其余代码不得直接 UPDATE status。

## 4. 接口契约

```ts
interface ChannelAdapter {
  name: string;
  start(onMessage: (m: IncomingMessage) => void): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

interface WorkerRunner {
  run(task: Task, workdir: string, onLog: (line: string) => void): Promise<WorkerResult>;
}

interface Deliverer {
  deliver(task: Task, workdir: string): Promise<{ branch?: string; prUrl?: string; files: string[] }>;
}
```

`IncomingMessage` 含 `eventId`、`channel`、`chatId`、`userId`、`text`、`repo?`。
`WorkerResult` 含 `ok`、`summary`、`error?`、`exitCode`。

## 5. 执行流程

1. 通道收到消息 → `router.handle(msg)`
2. 去重：`events.event_id` 冲突则直接返回
3. 判定：用户白名单 → 仓库白名单 → 触发词，任一不满足即拒（拒绝也记事件，防刷屏）
4. 建任务（`queued`）→ 回执「已接单」
5. 调度器取最早 `queued` → 建工作副本 → `running`
6. Worker 子进程在副本内执行，stdout 逐行写日志
7. 成功：提交 → 推送 → 开 PR → `succeeded` → 回执
8. 失败/超时：清理副本 → `failed` → 回执原因
9. 取消：置 `cancel_requested`，调度器检测后终止子进程 → `cancelled`

## 6. 安全边界

- Worker 进程**不持有**推送凭据；只在本地副本读写。提交、推送、开 PR 全部由 Router 执行。
- 触发词 + 双白名单（用户、仓库）三重校验；拒绝消息 24 小时内同一用户只回一次。
- 禁止操作在 Worker 提示词与 Router 提交前检查中各拦一次：`push --force`、`reset --hard` 到主干、删除未跟踪文件。
- 密钥只从环境变量读取：`PISA_TELEGRAM_TOKEN`、模型凭据沿用 omp 自身配置。
- 任务日志脱敏：token、cookie、私钥模式。

## 7. 失败与恢复

| 场景 | 处理 |
| --- | --- |
| Worker 超时（默认 60 min） | SIGTERM → 10s 后 SIGKILL，任务 `failed` |
| Worker 非零退出 | 取最后 20 行 stderr 作为原因 |
| Router 崩溃 | 启动时把 `running` 且无存活 PID 的任务标 `failed`，并回执「进程中断」 |
| 推送失败 | 保留本地分支，回执附本地路径与失败原因 |
| 重复事件 | `events` 主键冲突，直接丢弃 |

## 8. 测试策略

- **单元**：触发判定矩阵（用户/仓库/触发词 8 种组合）、状态跃迁非法路径、去重。
- **集成**：假 Worker（脚本返回固定 JSON）跑完整流程：建任务→执行→提交→回执。
- **端到端**：CLI 通道 + 临时 git 仓库，验证主分支零改动、分支有提交。
- 不测 Telegram 网络层，只测适配器的消息解析与发送参数。

## 9. 目录

```
pisa/
├── pisa.config.json
├── package.json
├── tsconfig.json
├── src/…
├── tests/…
└── .pisa/            # 运行时：db、worktrees、logs（gitignore）
```

## 10. 关键决策

- **不复用 pi SDK，直接起 CLI 子进程**：P0 只需要「给提示词、拿结果」，SDK 耦合会拖慢验证；子进程天然隔离，崩溃不影响 Router。
- **SQLite 而非 JSON 文件**：幂等需要唯一约束，排队需要排序查询，文件方案要自己实现两者。
- **每任务一个工作副本**：失败清理成本最低，且能并行化到 P1 不用改模型。
- **PR 创建做成适配器**：GitHub 用 `gh`，其他托管平台先推分支并给 compare 链接。

## 11. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| omp 输出格式变化 | 解析失败 | 只依赖退出码 + 最后一条 assistant 文本；JSON 解析失败则退回纯文本 |
| 长任务占满机器 | 后续任务饿死 | P0 串行 + 超时；P1 引入并发上限 |
| 推送权限过大 | 误改远端 | 只推 `pisa/*` 分支；主干保护交给平台 |
| Telegram 长轮询断线 | 收不到消息 | 指数退避重连，断线期间消息由平台保留 |
