# 017 · 提示词分层与版本

- 状态：implemented
- 关联：014-agent-cli（adapter 契约）、015-repo-ops

## 1. 问题

Worker 提示词全部写死在 `src/adapters/omp.ts` 的 `buildPrompt` 里：身份、恢复须知、上下文、任务、guard 约束拼成一个字符串。加一条团队约定或改评审标准要改代码、跑测试、发版；不同仓库也无法用同一份 pisa 定制各自的提示词。

证据：改动前 `src/adapters/omp.ts` 是唯一生成提示词的位置，`grep -r "你是 pisa 的 Worker" src/` 只命中该文件；仓库没有 `prompts/` 目录，配置里也没有提示词相关键。

## 2. 目标

- 提示词拆成有名字的段落，内置文本保留在代码里作为默认值
- 仓库可以用配置文件覆盖任意段落，不改代码、不发版
- 覆盖有显式版本号，非法配置启动即失败，而不是运行时才输出坏提示词
- 用 `/pisa prompts` 看清当前版本、覆盖来源和逐段差异

## 3. 用户故事

### US-1 仓库维护者

作为 pisa 的使用者，我在 `prompts/overrides.json` 写团队约定与评审标准，重启后新任务按我的规则执行，不需要改 `src/`。

### US-2 排查提示词的人

作为维护者，我在 IM 里发 `/pisa prompts`，能看到版本号、哪些段落被覆盖、覆盖文件在哪，以及每段和内置文本的 diff。

### US-3 写错配置的人

作为写错键名或占位符的人，pisa 启动时直接报出未知键或未知占位符并退出，不会带着坏提示词接单。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `src/prompts.ts`，段落固定为 `intro`、`team`、`resume`、`context`、`task`、`guard`，按此顺序拼接 |
| FR-002 | 内置提示词有版本号 `PROMPT_VERSION`，随代码发布 |
| FR-003 | 覆盖文件为配置文件同目录的 `prompts/overrides.json`，格式 `{ version, sections }` |
| FR-004 | 未覆盖段落回退内置文本；覆盖段落整段替换 |
| FR-005 | 启动时加载并校验：未知顶层键、未知段落键、版本不符、非字符串或空字符串、未知占位符、必需占位符缺失、未知 `.json` 文件均拒绝启动 |
| FR-006 | 占位符仅 `{{taskId}}`、`{{repo}}`、`{{prompt}}`、`{{context}}`，只替换模板层一次 |
| FR-007 | `/pisa prompts` 输出版本、覆盖来源、段落顺序与 diff；`/pisa prompts diff` 只输出 diff |
| FR-008 | Worker 与 Router 共用启动时加载的同一份分层结果 |

## 5. 非目标

- 不实现按仓库分层（验收只要求团队段落与内置段落）
- 不做热加载，改配置后重启生效
- 不引入 schema 库或 diff 依赖，校验与行级 diff 在本模块内实现

## 6. 验收

1. `prompts/` 目录有说明文件，模块导出 `PROMPT_VERSION`
2. 无覆盖文件时行为与改造前一致，全部使用内置段落
3. 覆盖 `team` 后，团队段落位于身份介绍之后、恢复段落之前
4. 覆盖 `guard` 后整段替换，未覆盖段落仍是内置文本
5. 未知键、未知段落、版本不符、空段落、未知占位符、缺必需占位符、未知 json 文件都抛 `PromptConfigError`，启动打印原因并退出
6. `/pisa prompts` 与 `/pisa prompts diff` 在 Router 测试中返回版本、来源和 diff 行
7. `bun test` 全绿，`bunx tsc --noEmit` 无报错
