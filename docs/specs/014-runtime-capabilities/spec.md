# 014 · Runtime 能力清单（capabilities）

- 状态：implemented
- 关联：001（任务与 Worker 装配）、008（多仓库配置）、009（定时任务）、012（命令守卫）
- 依赖：omp 的 `tool_call` 钩子与 `--add-dir`

## 1. 问题

Worker 以 pisa 进程的身份裸跑：继承全部环境变量（含 `PISA_TELEGRAM_TOKEN`），能读 `~/.ssh`、能连任意域名、能开浏览器，唯一的约束是扩展里的六条 `DENY` 正则。出了事无法回答「这个任务当时能碰什么」，也无法按仓库区分权限——改文档的仓库和跑发布脚本的仓库拿到同样的权限。

复现（改动前）：以 `sh -c env` 作为 Worker 命令，任务环境的敏感变量清单里出现 `PISA_TELEGRAM_TOKEN`，没有 `PISA_CAPABILITIES`；扩展对 `cat ~/.ssh/id_rsa`、`curl https://example.com`、`computer`、`browser` 全部放行。

## 2. 目标

- 每个任务有可声明、可留档的能力：可读目录、可写目录、可用密钥、可访问域名、是否允许 GUI
- 未声明的维度默认拒绝，只能由配置显式放行
- Worker 的 env 只含运行必需项与显式放行的密钥
- 越界调用被拒绝并留下审计记录，审计挂在任务上
- 能力可按仓库配置，定时任务可单独覆盖
- GUI 是独立开关，不与网络/目录权限捆绑

## 3. 用户故事

### US-1 按仓库收紧权限

运维给文档仓库配 `capabilities: {}`，给发布仓库配 `domains: ["api.github.com"]` 与 `secrets: ["GH_TOKEN"]`。文档任务里 `curl` 被拒绝并回帖告知，发布任务正常联网。

### US-2 事后追责

任务失败后查 `tasks.capabilities` 与 `task_audit`：知道它当时能读写哪里、允许哪些域名，以及它尝试过哪几条越界命令。

### US-3 定时任务单独放开

每日依赖升级的定时任务需要 `registry.npmjs.org`，普通交互任务不需要；在 job 上写 `capabilities` 覆盖仓库默认值。

### US-4 需要 GUI 的仓库

截图类仓库在档案里开 `gui: true`，其他仓库不开；GUI 工具与 `open`/`osascript` 只在开关打开时可用。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `CapabilitySpec { readDirs, writeDirs, secrets, domains, gui }`；`CapabilitiesConfig { default?, profiles? }`；仓库与定时任务用 `RepoCapabilities`（`profile` + 字段覆盖）声明 |
| FR-002 | 解析顺序：`capabilities.default` → 引用的 profile → 仓库层 → 任务层，后者覆盖前者；引用未知 profile 报错并拒绝建任务 |
| FR-003 | 工作目录始终可读可写；相对目录按工作目录解析；`domains` 去重转小写，子域自动放行 |
| FR-004 | 快照含绝对 `readDirs`/`writeDirs`、`secrets`、`domains`、`gui`、`profile` 与派生 `blockedCommands`，接单时写入 `tasks.capabilities` |
| FR-005 | Worker env 为白名单：基础系统变量 + `OMP_*`/`PI_*` 非密钥项 + 名单内密钥 + `PISA_CAPABILITIES`；名单外密钥不进子进程；声明的密钥缺失时报错 |
| FR-006 | bash 检查顺序：硬拒绝（`git push`、`git reset --hard`、`git clean -f`、`sudo`、`rm -rf /`、`chmod/chown /etc`）→ GUI → 网络 → 路径 → 写目标 |
| FR-007 | 网络命令（curl/wget/ssh/scp/rsync/git 远端操作等）在 `domains` 为空时一律拒绝；非空时命令里出现的主机必须在名单内。主机取 URL authority 到 `#`/`?` 为止、`user@host` 取 `@` 之后的部分 |
| FR-008 | 绝对路径、`~` 路径与含 `..` 的相对路径必须在 `readDirs` 内（命令首词位于系统 bin 目录除外）；重定向、`tee`、`mkdir`、`cp/mv` 落点必须在 `writeDirs` 内。检查前去掉成对引号；含 `$` 变量且无法静态判定的路径与写入落点一律拒绝 |
| FR-009 | 文件工具（`read`/`glob`/`grep`/`lsp`）按 `readDirs` 校验，`edit`/`write`/`ast_edit` 按 `writeDirs` 校验；内部 URI 与 `*.db:表` 前缀按规则剥离 |
| FR-010 | GUI 未开启时拒绝 `computer`/`browser`/`pencil` 类工具与 `open`/`osascript`/`screencapture` 等命令 |
| FR-011 | 扩展拒绝调用时返回 `{block:true, reason}` 并写 `blocked` 进度事件；Router 把事件写入 `task_audit`，进程退出前补读尾部 |
| FR-012 | 提示词列出能力边界；`readDirs`/`writeDirs` 中工作目录之外的目录通过 `--add-dir` 交给 omp，避免工具层先拒绝 |
| FR-013 | 旧库迁移补 `capabilities` 列；升级前接单的任务在执行前按当时配置补算并落库 |

## 5. 验收

1. `capabilities` 可按仓库声明，定时任务可覆盖
2. Worker 启动时 env 只含白名单与放行密钥，`PISA_CAPABILITIES` 携带快照、可写目录与 `blockedCommands`
3. 越界命令被拒绝：仓库外路径、未授权域名、未开 GUI、破坏性命令
4. 拒绝记录写入 `task_audit`，可用 `auditOf(taskId)` 读出
5. 未声明维度默认拒绝；显式配置的目录/域名/密钥/GUI 生效
6. GUI 由单一开关控制，与网络、目录权限互不牵连
7. 测试覆盖默认拒绝与显式放行两条路径，含扩展实际拦截与审计落库

## 6. 非目标

- 扩展不是沙箱：它与 agent 同进程，`eval` 或加载的第三方代码仍能绕过钩子；本规格只约束工具调用这一层
- MCP 工具不在 `domains` 管辖范围（各自有独立网络栈），只按 GUI 名称过滤
- 包管理器（`bun install` 等）的注册表请求不按域名检查
- 不限制 agent 自身的模型凭据（omp 用自己的凭据库）
