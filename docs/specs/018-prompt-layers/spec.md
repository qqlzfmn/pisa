# 018 · 提示词分层与版本

- 状态：implemented
- 关联：001-router-worker（Worker 提示词）、005-crash-resume（恢复段）、改进项 `seed:prompt-layers`

## 1. 问题

Worker 提示词写死在 `src/adapters/omp.ts` 的 `buildPrompt()` 里：介绍、恢复核对、上一轮上下文、任务正文、约束五部分全部是 TS 字符串。后果有三：

- 调整一句评审标准或团队约定要改代码、发版；用户在 `pisa.config.json` 里没有入口。
- 恢复段与上下文段由布尔开关拼接，顺序和内容只能靠读代码确认。
- 提示词没有版本，改动后无法回答「线上跑的是哪一版」「这个仓库和内置差在哪」。

复现：改动前把仓库切到现状，`grep -n "buildPrompt" src/adapters/omp.ts` 只能看到硬编码数组；`/pisa help` 里没有查看提示词的命令；配置示例里没有提示词相关键。

## 2. 目标

- 提示词从代码搬到数据文件，内置一份可读的默认值。
- 团队与单个仓库能在不改代码的前提下覆盖，且只覆盖想改的段落。
- 每份文件带版本；入口命令能看组合结果与覆盖差异。
- 非法配置在启动时失败，不拖到第一个任务。

## 3. 用户故事

### US-1 团队维护者

我在 `prompts/team/worker.md` 里改「约束」段落，加上内部评审标准，重启 pisa 后所有仓库的任务都按新约束执行；其他段落继续跟随内置版本。

### US-2 单仓库负责人

只有一个仓库需要额外上下文，我在 `prompts/team/repos/<别名>.md` 里覆盖 `intro` 或 `constraints`，其他仓库不受影响。

### US-3 评审者

我用 `/pisa prompts` 看到内置、团队、仓库三层的版本与每个段落的来源；用 `/pisa prompts diff` 看到覆盖段落相对内置的逐行差异，以及版本从几变到几。

### US-4 排障者

覆盖文件写错段落名或缺 `version` 时，守护进程启动即报出文件与原因并退出，而不是等任务跑起来才发现提示词不对。

## 4. 需求

提示词由固定五段组成，渲染顺序固定：`intro` → `resume`（仅恢复任务）→ `context`（仅有上下文时）→ `task` → `constraints`。

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `prompts/worker.md` 作为内置提示词，front matter 写 `version`，正文用 `<!-- section: <key> -->` 切段；内置文件必须提供全部五段 |
| FR-002 | 新增 `src/prompts.ts`：`PromptLibrary` 负责读取与组合，`renderWorkerPrompt()` 负责占位符替换，`formatPrompts()` 负责查看与 diff；不引入第三方依赖 |
| FR-003 | 覆盖顺序为仓库层 > 团队层 > 内置，按段落独立生效；未覆盖的段落回退到下一层。团队目录 `prompts.dir` 默认是配置文件同级的 `prompts/team`，相对路径按配置文件目录解析 |
| FR-004 | 团队层文件为 `<prompts.dir>/worker.md`，仓库层为 `<prompts.dir>/repos/<别名>.md`；文件可只包含部分段落；不存在即视为无覆盖 |
| FR-005 | 每个文件的 front matter 只接受 `version`（≥1 的整数）；未知键、未知段落、重复段落、空段落、段落标记前有正文、内置缺段都抛 `PromptError`，启动时校验仓库清单并退出 1 |
| FR-006 | 提示词组装从适配器移出：`AdapterInput.prompt` 携带渲染结果，`OmpAdapter` 只把它放进 `-p`；删除 `buildPrompt` 及其再导出 |
| FR-007 | 新增 `/pisa prompts`（别名「提示词」）与 `pisa prompts`，按仓库列出 `worker · 内置 vN · 团队 vN · 仓库 vN` 及每个段落的来源与版本；`diff` 子参数只展开被覆盖段落的统一 diff 并标出版本变化 |
| FR-008 | 私聊 `dmWithoutTrigger` 下 `/prompts` 与「提示词」免触发词，与其他查询命令一致 |
| FR-009 | 覆盖文件在进程启动时读入缓存，修改后重启生效；未知仓库别名不做路径拼接，仓库层直接忽略 |
| FR-010 | 测试覆盖组合顺序、逐段回退、无覆盖、版本变化、非法配置、命令输出与适配器只消费渲染结果 |

不在本次范围：按任务或用户维度覆盖、运行时热加载、提示词模板语言（条件/循环）、自动版本号递增。版本由维护者随内容修改手动递增，diff 只展示声明值。

## 5. 验收

1. `prompts/` 目录存在，内置文件带 `version`。
2. 启动加载全部覆盖文件；未知键/未知段落/缺版本等直接失败。
3. `/pisa prompts` 可查看组合与版本，`/pisa prompts diff` 给出覆盖段落的差异。
4. 团队与仓库覆盖只改文件、不改代码，重启后生效。
5. `bun test` 覆盖组合顺序、回退默认、非法配置；`bunx tsc --noEmit` 通过。
