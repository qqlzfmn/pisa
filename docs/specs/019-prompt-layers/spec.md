# 019 · 提示词分层与版本

- 状态：implemented
- 关联：005-crash-resume（恢复段）、014-worker-guard（约束段）、012-command-guard（命令清单）

## 1. 问题

Worker 的提示词只有一份，写在 `src/adapters/omp.ts` 的 `buildPrompt()` 里：任务号、恢复执行、上一轮上下文、任务正文、约束五段都是字符串字面量。带来两个后果：

- 团队要补一条评审标准、换一种恢复策略，只能改代码、发版、重启。仓库配置里没有任何提示词入口，评审标准无法按仓库定制。
- 改动没有版本号，也没有查看与比较的出口。线上到底加载了哪一版提示词，只能去翻源码。

复现：`git diff` 之外没有任何方式回答「当前提示词和默认值差在哪」；`/pisa help` 的查询类命令只有 status、schedules、examples、verbose。

## 2. 目标

- 内置段落与覆盖文件分离；覆盖是数据，不改代码
- 启动时一次性加载；未知段落键、未知仓库别名、非法版本号、空文件、未知模板变量直接拒绝启动并点名文件
- 覆盖有版本号；`/pisa prompts` 查看版本、每段生效来源，`/pisa prompts diff [@仓库]` 查看与内置的差异
- 覆盖优先级固定：仓库 > 团队 > 内置；未覆盖的段落回退到下一层
- 未放置 `prompts/` 目录时行为与改造前完全一致

## 3. 分层与文件格式

覆盖目录默认是配置文件所在目录下的 `prompts/`，可用 `promptsDir` 改到别处（相对路径按配置目录解析）。

```
prompts/
  VERSION                正整数，改任何段落后递增
  worker.intro.md        团队覆盖（可选，任意段）
  worker.constraints.md
  repos/
    demo/                仓库别名，必须在配置的 repos 里
      worker.task.md     该仓库的覆盖，优先于团队
```

段落键是封闭集合，文件名去掉 `.md` 即键名：

| 键 | 模板变量 | 内容 |
| --- | --- | --- |
| `worker.intro` | `{{taskId}}` | 任务号与角色 |
| `worker.resume` | — | 恢复执行前的核对步骤 |
| `worker.context` | `{{context}}` | 上一轮上下文标题与正文 |
| `worker.task` | `{{prompt}}` | 任务正文 |
| `worker.constraints` | — | guard 边界、评审与交付要求 |

拼接顺序固定：`worker.intro` → `worker.resume`（仅恢复任务）→ `worker.context`（有上下文时）→ `worker.task` → `worker.constraints`，段落之间一个空行。覆盖是整段替换，不做同键拼贴；需要组合时把内容写进同一个覆盖文件。

## 4. 需求

- FR-001：`src/prompts.ts` 是段落清单、内置文本与加载逻辑的唯一来源；`omp` 适配器只负责把 `PromptBook` 交给 `buildWorkerPrompt`。
- FR-002：`loadPrompts(dir, repoAliases)` 在启动时加载；目录不存在返回纯内置，目录存在时 `VERSION` 必填且为正整数。
- FR-003：团队层读取 `prompts/<key>.md`；仓库层读取 `prompts/repos/<alias>/<key>.md`；`repos/` 下的目录名必须是已配置的仓库别名。
- FR-004：覆盖文件里的占位符只能使用该段声明的变量；未知变量、空文件、未知键都在加载时报错，错误信息包含层（团队/仓库别名）与文件名。
- FR-005：`/pisa prompts` 输出版本、覆盖计数、每段来源（内置/团队/仓库别名）与覆盖目录；`/pisa prompts diff` 只输出被覆盖段落的 unified diff；`@仓库` 按该仓库解析；未配置的仓库别名给出可用列表。
- FR-006：`pisa.config.json` 支持 `promptsDir`，缺省 `<配置目录>/prompts`。

## 5. 验收

| 验收项 | 覆盖 |
| --- | --- |
| `prompts/` 目录 + 版本号 | `prompts/VERSION`；`tests/prompts.test.ts` 的「缺少 VERSION 或版本号非法时拒绝启动」 |
| 启动加载，未知键拒绝 | `src/index.ts` 加载失败退出；「未知段落键」「未知仓库别名」用例 |
| `/pisa prompts` 查看与 diff | `tests/router.test.ts` 的 prompts 三条用例；`tests/prompts.test.ts` 的查看与 diff 组 |
| 覆盖无需改代码 | 「团队覆盖只替换对应段落，其余回退内置」；「仓库覆盖优先于团队覆盖」 |
| 组合顺序、回退默认、非法配置 | 「段落顺序固定」「没有覆盖目录时回退到内置」「非法配置」组 |

## 6. 非目标

- 不做热加载：改覆盖文件后重启生效，避免运行中的任务看到半套提示词。
- 不为覆盖保留历史版本：版本号由维护者递增，比较对象是内置文本；历史在 git 里。
- 不接管 `proactive` 的关键词/探针提示词：它们已有 `proactive.*.prompt` 配置项，语义是单条指令而非分层段落。
