# 014 · 任务

- [x] `src/ids.ts`：`newTaskId`，Router 与 CLI 共用
- [x] `src/task-context.ts`：`continuationContext`，抽出 Router 内联拼接
- [x] `src/status.ts`：看板、`daemonState`、`HEARTBEAT_STALE_MS`、格式化函数
- [x] `src/store.ts`：`meta` 表、`beat` / `lastBeat`、`taskByEvent`、`insertTaskOnce`、`listTasks`、`tasksByPr`
- [x] `src/config.ts`：`findConfig` 向上查找；`stateDir` 与仓库路径锚定到配置文件目录
- [x] `src/router.ts`：改用共享模块；调度循环写心跳；CLI 任务不回执聊天通道
- [x] `src/cli.ts`：一次性命令、JSON 输出、退出码、`--wait`
- [x] `package.json`：`bin.pisa`
- [x] `docs/specs/014-agent-cli/`：spec / plan / tasks
- [x] `tests/cli.test.ts`：提交、幂等、鉴权、续跑、等待、查询、取消、日志、路径锚定
- [x] `skills/pisa/SKILL.md` 与 `references/`：命令表、brief 模板、失败模式、能力边界、3 个场景
- [x] `README.md`：CLI 与 skill 入口
- [x] 验证：`bun test`、`bunx tsc --noEmit`、临时目录端到端
