# 参与开发

## 环境

| 依赖 | 要求 | 用途 |
| --- | --- | --- |
| [bun](https://bun.sh) | 1.4.4（CI 固定此版本） | 运行时、测试、类型检查 |
| [omp](https://github.com/earendil-works/pi) | 能在 `PATH` 里直接执行 | 跑真实任务时的 Worker 适配器 |
| `gh` | 已 `gh auth login` | PR 创建、Issue/PR 评论轮询、`rewind` |
| git | 任意近期版本 | 工作副本、分支、交付 |

只跑测试时只需要 bun：`gh` 与 Worker 在测试里都用替身，不需要真实 token，也不会发出真实调用。

## 跑起来

```bash
bun install
cp pisa.config.example.json pisa.config.json    # 改 repos[].path 与白名单
bun run dev                                     # 等价 bun run src/index.ts --channel cli
```

`pisa.config.json`、`.pisa/`、`*.db` 都在 `.gitignore` 里。密钥不进配置：配置只写环境变量名（`*tokenEnv`），值用 `export` 注入，见 README「快速开始」。

Telegram 通道还需要 `PISA_TELEGRAM_TOKEN`；GitHub 评论轮询需要 `GH_TOKEN`。

## 常用命令

```bash
bun test                        # 全部测试
bun test tests/router.test.ts   # 单个文件
bunx tsc --noEmit               # 类型检查
```

两个命令都必须是绿的。CI 在每次 push 与 PR 上跑同样的两步（`.github/workflows/ci.yml`），本地没跑过就推等于让 CI 替你跑。

升级 bun 版本时同步修改 `.github/workflows/ci.yml` 的 `bun-version`：`bun test` 的行为与 `@types/bun` 都跟运行时版本相关，两边不一致会出现本地绿、CI 红。

## 开发流程

本项目用规格驱动开发（SDD），完整规则见 [SDD.md](./SDD.md)：

```
specify → plan → tasks → implement → converge
```

落到日常动作：

1. 行为变更先写 `docs/specs/<NNN-name>/spec.md`：用户是谁、要什么、如何验收，需求带 ID（`US-1` / `FR-001`）。只写 WHAT / WHY，不写实现。
2. `plan.md` 写技术决策与理由，`tasks.md` 拆成可独立验证的任务。
3. 先写失败测试，确认红相，再写实现。
4. 一个 feature 一个分支，从 `main` 拉出，经 PR 合回 `main`。不直接提交 `main`。
5. 改完代码回头检查规格、计划、任务与代码是否一致，不一致就改文档。

编号规则：`docs/specs/` 下扫描现有目录，取三位递增编号加 kebab-case 名称（当前最新为 `014-repo-ops`）。

琐碎改动（错别字、单行修正）不强制走规格。

## 提交规范

Conventional Commits，一个提交一件事：

```
feat(router): 支持按仓库别名路由
fix(github): 评论轮询失败时不推进下界
docs(spec): 补 014 的验收场景
```

- 类型用 `feat` / `fix` / `refactor` / `docs` / `test` / `chore`
- scope 用模块名：`router`、`worker`、`github`、`scheduler`、`config`、`store`、`spec` 等
- 主题行写做了什么，不写「update」这类无信息量的词
- 关联 Issue 用 `closes #N`

只提交自己改的文件：显式 `git add <path>`，提交前 `git status` 确认。不用 `git add -A`。

## 代码要求

细节见 [AGENTS.md](./AGENTS.md)，两条底线：

- 单一事实源：同一份信息只保留一处（命令清单、规格、配置默认值都不复制）
- 不引入技术债：结构问题用重构解决，不用特例绕过

行为变更必须带测试；测试用本地替身模拟外部依赖，不调真实付费 API、不用真实密钥。

本仓库当前 `private: true`，未附 LICENSE 文件。

## PR

PR 模板会自动带出，按段填写：

- 目的、背景、方案
- 影响与风险，**必须写回滚方式**
- 验证：贴实际跑过的命令与结果

自查清单在模板末尾；未跑过的检查不要勾。

## 报告问题

- 缺陷与功能建议走 Issue 模板：`.github/ISSUE_TEMPLATE/`
- 安全漏洞不要开公开 Issue，按 [SECURITY.md](./SECURITY.md) 私密上报
