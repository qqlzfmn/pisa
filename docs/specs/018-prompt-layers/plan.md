# 018 · 实现计划

- 输入：`spec.md`
- 约束：不引入依赖；不改 `.pisa/`；保持现有提示词文本与恢复语义不变

## 1. 技术决策

| 决策 | 结论 | 依据 |
| --- | --- | --- |
| 内置位置 | 包根 `prompts/worker.md`，由 `import.meta.dir` 定位 | 与 `extensions/` 同级，随包分发；不依赖 cwd |
| 团队目录 | `prompts.dir` 默认 `<配置目录>/prompts/team`，在 `loadConfig` 解析为绝对路径 | 守护进程与 CLI 从不同 cwd 启动时指向同一份文件 |
| 分层粒度 | 按段落覆盖，不整文件替换 | 团队只想改约束时不必复制其余四段，减少漂移 |
| 文件格式 | front matter 只放 `version`；正文按 `<!-- section: key -->` 切段 | Markdown 可读，解析器 20 行内；未知键直接拒绝，避免拼写错误静默失效 |
| 组合时机 | `Worker.run` 按任务仓库解析并渲染，`PromptLibrary` 缓存到进程结束 | 每次任务读盘会引入文件竞态；改动重启生效与配置一致 |
| 适配器职责 | `AdapterInput.prompt` 必填，`OmpAdapter` 不再拼提示词 | 提示词属于 pisa 核心，不属于某个 agent；换适配器仍用同一分层 |
| 校验时机 | `index.ts` 启动时 `validate(cfg.repos)`；CLI `prompts` 即时解析 | 非法覆盖要在接单前失败；CLI 也应给出同样的错误 |
| 展示 | `formatPrompts` 输出视图与统一 diff，含版本标签 | 单条消息可读；diff 用 LCS，行数很小，不值得引入 diff 库 |
| 仓库别名 | 只接受 `[A-Za-z0-9_-]+`，不合规直接跳过仓库层 | 防止别名拼进路径；现有 IM 别名本就在此字符集内 |
| 版本号 | 文件内手写，展示与 diff 使用声明值 | 不引入自动递增，避免提示词内容与 git 提交耦合 |

## 2. 影响面

- `prompts/worker.md`：内置五段提示词，来自原 `buildPrompt`
- `src/prompts.ts`：解析、分层、渲染、格式化与单测入口
- `src/worker.ts`：构造注入 `PromptLibrary`，渲染后写入 `AdapterInput.prompt`
- `src/adapters/omp.ts`、`types.ts`、`index.ts`：删除 `buildPrompt`，`-p` 直接取 `input.prompt`
- `src/config.ts`：`prompts.dir`、`prompts` 命令与默认目录解析
- `src/router.ts`、`src/cli.ts`、`src/index.ts`：命令入口、启动校验与日志
- `pisa.config.example.json`、`docs/operations.md`、`docs/architecture.md`、`CHANGELOG.md`
- 测试：`tests/prompts.test.ts` 新增；适配器、Worker、Router、CLI 测试同步

## 3. 验证

| 层 | 检查 |
| --- | --- |
| 解析 | 内置完整文件、部分覆盖文件、空 front matter → 对应错误 |
| 组合 | 仓库 > 团队 > 内置；未覆盖段落来源与版本不变 |
| 渲染 | 五段顺序、恢复与上下文开关、占位符只替换一次 |
| 命令 | Router `/pisa prompts`、`/pisa prompts diff`、私聊 `/prompts`；CLI 视图、diff、非法参数 |
| 启动 | 手工以非法覆盖文件启动，确认退出码 1 与错误路径 |
| 全量 | `bun test`、`bunx tsc --noEmit` |
