# 014 · 实施计划

## D1 单个工作流 `.github/workflows/ci.yml`

- 触发 `push` + `pull_request`，任意分支；`concurrency` 同一 ref 取消旧运行，避免连续 push 排队白跑。
- 步骤顺序 install → test → typecheck，分步以便失败定位。
- `permissions: contents: read`：工作流只读仓库，不需要写权限。
- `bun-version: 1.4.4` 与本机 `bun --version` 一致。测试依赖 `bun test` 的语义与类型定义 `@types/bun`，版本漂移会带来假红；升级 bun 时同步改这一处，CONTRIBUTING 记录该约定。
- `timeout-minutes: 10`：本地 128 个测试约 7 秒，超时说明是环境问题而不是测试慢。

对应 FR-001、FR-002。

## D2 Issue 用 YAML 表单（Issue Forms），不用 markdown 模板

`bug_report.yml` / `feature_request.yml` 的必填校验由 GitHub 执行，不需要自己写检查脚本；markdown 模板只能靠人自觉。

- 字段收敛：bug 五项（复现步骤、期望、实际、环境、影响范围），feature 三项（问题、期望、影响范围）。
- bug 表单放一个必勾选项「已删除 token、chat id 等敏感信息」，把 SECURITY 的脱敏要求前置到提交动作。
- `config.yml` 设 `blank_issues_enabled: false`，强制走模板。
- 不写 `labels`：标签是否存在于仓库侧设置未知，写了也可能不生效。

对应 FR-003、FR-004、FR-005。

## D3 PR 用 markdown 模板

PR 需要自由正文与勾选清单，YAML 表单不适合。段落顺序照 AGENTS 的沟通规范：目的 → 背景 → 方案 → 影响与风险 → 验收。

回滚写成固定一行，不选填：改动方知道怎么退，评审才敢合。

对应 FR-006。

## D4 CONTRIBUTING 只写可执行的命令

每条命令都是从 `package.json` scripts 或仓库实际脚本抄来的，不发明脚本名。内容按「装 → 跑 → 测 → 提」排列，规格流程指向 `SDD.md` 而不复述全文。

对应 FR-007。

## D5 SECURITY 只写代码能证明的边界

每条都对应可查的源码位置：

- 入口鉴权：`src/router.ts` 的 `checkAccess`（`whitelist.users` / `whitelist.repos`）；`src/index.ts` 的 webhook 只监听 `127.0.0.1` 且校验 `x-pisa-token`。
- GitHub 评论作者不参与鉴权（`docs/specs/011-multi-repo-github/spec.md`），能评论 watched repo 的人就能派活。
- Agent 以 pisa 进程所属系统用户身份执行，能读写该用户可访问的一切；`extensions/pisa-worker.ts` 的 `DENY` 是命令字符串正则，属于误触防护，不是沙箱。
- 密钥只从环境变量读（`tokenEnv` 指向变量名，配置里不存值）；`src/log.ts` 的 `redact` 是模式匹配，覆盖 Telegram bot token、`gh*_`、`sk-`、`key=value` 这类形态，不保证覆盖自定义格式。
- 上报走 GitHub Security Advisories 私密报告，不编造邮箱。

对应 FR-008。

## D6 CHANGELOG 按版本、只记用户可见变化

结构照 Keep a Changelog：`Unreleased` + 版本段 + `Added / Changed / Fixed / Removed / Security`。版本号与 `package.json` 的 `version` 对齐（当前 0.1.0）。

未发布的版本不写日期：避免伪造发布日；打 tag 时补日期。

对应 FR-009。

## D7 README 只补入口，不加徽章

徽章需要 `owner/repo`，当前 worktree 无远程配置，猜一个就是假链接，因此不做（spec 非目标）。README 增加「贡献」小节指向 CONTRIBUTING / SECURITY，并把「测试 89 个全绿」改成不含计数的表述：计数会随测试增加而失真。

对应 FR-010。

## 验证

- 本地按 CI 步骤逐条执行：`bun install --frozen-lockfile`、`bun test`、`bunx tsc --noEmit`
- 用一次性脚本解析 `ci.yml` 与两个 Issue 表单，校验 YAML 合法、issue form 具备 `name` / `description` / `body`、每个字段有 `id` 与 `type`、必填字段带 `validations.required`
- 文档类改动不新增单元测试：断言模板文本属于对源码文本的测试，不能发现真实缺陷（无用变更检测）
