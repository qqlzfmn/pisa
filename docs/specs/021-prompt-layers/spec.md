# 021 · 提示词分层与版本

- 状态：implemented
- 关联：`src/prompts.ts`、`src/config.ts`、`src/adapters/omp.ts`、`src/pr-review.ts`

## 1. 问题

Worker 与 PR 评审的提示词写死在 `src/adapters/omp.ts` 与 `src/pr-review.ts` 里。方案约束、评审标准每调一次都要改代码、发版；同一团队的不同仓库也不能有各自的评审标准。硬编码文本还让「改了什么」无法回答：没有版本号，也没有 diff。

## 2. 需求

- FR-021-1：`prompts/` 目录保存覆盖文本，`prompts/version` 记录版本号；加载时版本号必须是正整数。
- FR-021-2：提示词按「仓库 > 团队 > 内置」三层解析，每段独立覆盖；段落顺序、变量与开关由代码里的段落表固定，覆盖只能替换文本。
- FR-021-3：启动时加载；出现未知键、未知变量、空文件、非法版本、未知目录时启动失败并指出路径，不静默忽略。
- FR-021-4：`/pisa prompts` 列出版本、覆盖目录与每段来源；`/pisa prompts diff <键>` 按层给 diff；`--repo` 查看仓库视角。CLI 同名命令输出文本或 `--json`。
- FR-021-5：`review.criteria` 没有内置正文，只在团队或仓库覆盖时出现，用来放仓库自己的评审标准。
- FR-021-6：`promptsDir` 配置覆盖目录，默认 `prompts`，相对配置文件所在目录；目录不存在时全部走内置。

## 3. 非目标

- 不做提示词热加载：版本与覆盖在进程启动时确定，改完重启生效。
- 不做任意模板/条件 DSL：键是固定集合，占位符只允许该段声明的变量。
- 不接管 agent 自身的系统提示词；只改 pisa 拼出来的 user prompt。

## 4. 验收

1. `prompts/version` 存在时 `/pisa prompts` 显示该版本，不存在时显示内置版本 1。
2. 团队段落覆盖后，`/pisa prompts diff <键>` 显示 `--- 内置` 与 `+++ 团队` 两段。
3. `prompts/repos/<owner>__<repo>/review.criteria.md` 只影响该仓库的评审提示词，其它仓库退回团队层。
4. 未知键或未知变量让 `loadConfig` 抛错，进程无法启动。
5. 段落顺序与恢复开关由段落表决定：覆盖不了顺序，也绕不过开关。
