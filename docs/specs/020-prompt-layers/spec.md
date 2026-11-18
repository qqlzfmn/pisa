# 020 · 提示词分层与版本

- 状态：implemented
- 关联：014-worker-guard（约束由 guard 强制，提示词只是告知）、019-reconcile（命令清单单一事实源）

## 1. 问题

Worker 与主动发现的提示词全部写死在代码里：

- `src/adapters/omp.ts` 的 `buildPrompt` 直接拼标题、恢复段、上下文、任务、约束与完成标准，改一句话就要改代码、发版；
- 团队想调整语气、补充仓库约定，或按仓库定制评审标准，没有入口；
- 现有 `/pisa help` 看不到当前生效的是哪一段、来自哪里、与内置版本差了什么；
- 主动发现的两个默认提示词也写死在 `src/proactive.ts`。

## 2. 目标

- 提示词拆成带版本的段落文件，放 `prompts/`，与源码一起评审、随仓库发版；
- 团队覆盖放配置目录下的 `prompts.d/`，按仓库覆盖放 `prompts.d/repos/<别名>/`，不用改代码；
- 启动时加载并校验，未知段落、坏版本、未知占位符、未登记文件直接拒绝启动；
- `/pisa prompts` 查看每个段落的生效版本与来源，`/pisa prompts diff [键]` 看与内置版本的 unified diff；
- 拼装顺序固定，缺省回退内置，行为与改造前一致；
- 非法配置、覆盖优先级、拼装顺序都有测试。

## 3. 目录与版本

```text
prompts/
  manifest.json          # 段落清单与版本号：{ "version": 1, "sections": { "worker.title": 1, ... } }
  worker/
    title.md
    resume.md
    context.md
    task.md
    constraints.md
    review.md
  proactive/
    keywords.md
    probe.md
```

- 段落的文件路径由键推导：`worker.review` → `prompts/worker/review.md`；
- 键必须登记在 `manifest.json`，目录里多出未登记的 `.md` 直接报错；
- 版本号是正整数，写在清单与覆盖文件的头部；段落正文变化时同步 bump，`diff` 用来审阅内容差异；
- 正文里的占位符只能用 `{{taskId}}`、`{{prompt}}`、`{{context}}`，写错在加载时报错，不等到 Worker 跑到一半。

## 4. 覆盖

配置项 `prompts.dir`，默认 `prompts.d`，相对路径以配置文件所在目录为基准：

```text
prompts.d/
  worker.review.md                 # 团队覆盖
  worker.title.md
  repos/
    pisa/
      worker.review.md             # 仓库 pisa 覆盖
```

覆盖文件格式：

```markdown
---
version: 2
---

## 完成标准
- ...
```

- 只允许 `version` 一个头部键；缺少头部或版本不是正整数直接报错；
- 文件名就是段落键；未登记的键报错；
- `repos/<别名>` 的别名必须在配置 `repos` 里，写错报错而不是静默忽略；
- 覆盖目录不存在时只用内置段落；`.` 开头的条目忽略；
- 优先级：仓库覆盖 > 团队覆盖 > 内置。

## 5. 拼装

`buildPrompt` 顺序固定：

| 顺序 | 段落 | 条件 |
| --- | --- | --- |
| 1 | `worker.title` | 总是 |
| 2 | `worker.resume` | 仅恢复中断任务 |
| 3 | `worker.context` | 仅任务带上一轮上下文 |
| 4 | `worker.task` | 总是 |
| 5 | `worker.constraints` | 总是 |
| 6 | `worker.review` | 总是 |

段落之间空一行。主动发现的关键词与探针提示词分别取 `proactive.keywords`、`proactive.probe`，配置里显式写了 `prompt` 时以配置为准。

## 6. 需求

| 编号 | 需求 |
| --- | --- |
| FR-1 | `prompts/` 提供清单与全部内置段落，每段带版本号 |
| FR-2 | 启动加载；未知键、未知占位符、坏版本、未登记文件、未知仓库别名都以非零退出码拒绝启动 |
| FR-3 | `/pisa prompts` 列出每个段落的生效版本与来源；`/pisa prompts diff [键]` 输出与内置版本的 unified diff，不传键时列出所有被覆盖段落 |
| FR-4 | 覆盖只改文件，无需改代码；仓库覆盖按任务所在仓库生效 |
| FR-5 | 覆盖目录缺失时回退内置；解析顺序仓库 > 团队 > 内置 |
| FR-6 | 拼装顺序与原有提示词内容保持一致，现有 Worker 行为不变 |
| FR-7 | 主动发现默认提示词也从内置段落读取，显式配置优先 |

## 7. 验收

- `bun test` 覆盖：内置加载、拼装顺序、恢复段与上下文段的条件拼装、团队覆盖、仓库覆盖优先于团队、缺省回退、未知键拒绝、坏头部/版本/占位符/仓库别名拒绝、diff 内容、`/pisa prompts` 输出；
- 启动时打印提示词版本与段落数；把覆盖文件写成未知键后进程以非零码退出并打印原因；
- `bunx tsc --noEmit` 无输出。

## 8. 非目标

- 不做热更新：提示词是启动配置，改完重启，与配置文件的语义一致；
- 不做覆盖文件的内容指纹：版本号由作者维护，diff 负责审阅差异；
- 不允许覆盖段落拼装顺序或新增段落：顺序属于代码行为，新增段落需要同步改拼装逻辑与清单。
