# 001 · 任务拆分（tasks）

对应 [spec.md](./spec.md) 与 [plan.md](./plan.md)。每个任务独立可验证，按顺序执行。

## T1 项目骨架

- [x] `package.json`（Bun，零第三方运行时依赖）
- [x] `tsconfig.json`（strict + noUncheckedIndexedAccess）
- [x] `.gitignore`、`pisa.config.example.json`
- 验证：`bun install && ./node_modules/.bin/tsc --noEmit` 无报错

## T2 类型与配置

- [x] `src/types.ts`：Task、TaskStatus、ChannelAdapter、状态跃迁表
- [x] `src/config.ts`：配置加载、环境变量覆盖、触发词解析
- 验证：`parseCommand` 单测 3 例通过

## T3 存储与幂等

- [x] `src/store.ts`：任务表、事件去重表、唯一状态写入口
- [x] `markOrphansFailed`：重启清理 running
- 验证：非法跃迁返回 false；重复事件只建一个任务

## T4 Worker 适配

- [x] `src/worker.ts`：`omp --mode=json -p` 子进程、流式日志、超时与取消
- [x] 提示词内置安全约束（不 commit / 不 push / 不 reset 主干）
- 验证：假 Worker 集成测试；真实 omp 冒烟（见 T9）

## T5 交付

- [x] `src/git.ts`：工作副本、提交、推送、compare 链接、PR
- [x] `src/deliver.ts`：有改动才提交；推送/PR 受配置控制
- 验证：分支有文件、主分支无文件

## T6 路由与调度

- [x] `src/router.ts`：鉴权 → 去重 → 建任务 → 排队 → 执行 → 回执
- [x] 取消（排队直接取消，执行中置标记）
- [x] 拒绝提示 24h 节流
- 验证：6 个 Router 用例通过

## T7 通道

- [x] `src/channels/cli.ts`：本地验证用
- [x] `src/channels/telegram.ts`：long polling + 分段发送
- 验证：CLI 通道手动跑通（见 T9）；Telegram 需 token

## T8 组装

- [x] `src/index.ts`：配置 → 存储 → 通道 → 路由，SIGINT/SIGTERM 优雅退出
- 验证：`bun run src/index.ts --channel cli` 启动无异常

## T9 端到端验证

- [x] 临时 git 仓库 + 假 Worker：接单 → 执行 → 提交到 `pisa/<id>` → 主分支干净 → 回执
- [x] 真实 omp Worker 冒烟（一次最小改动）：改 `a.txt` → 提交到分支 → 主分支不变
- [ ] Telegram 通道联调（需 bot token）

## T10 收尾

- [x] README 补「快速开始」
- [x] 提交到 `001-router-worker` 分支
