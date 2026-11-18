# 018 · Runtime 能力清单

- 状态：implemented
- 关联：014-worker-guard（命令拦截）、012-command-guard（prompt 边界）、017-task-stages（任务投影）

## 1. 问题

Worker 以当前用户身份裸跑。它继承的环境变量只有 `worker.envAllow` 白名单，但文件、网络与 GUI 没有边界：

- 文件工具只校验路径在 worktree 内；bash 的 `cat /etc/passwd`、`tee /任意路径`、`cp` 到用户目录都不拦。
- 网络命令没有限制：`curl`、`wget`、`ssh`、`git clone` 可以访问任意域名。
- GUI 命令没有开关：`open`、`osascript` 直接可用。
- 上述边界是全局的，不能按仓库或任务声明；出了事无法从任务记录回答「这个任务能碰什么」。

证据（改动前）：`extensions/guard.ts` 的 `blockBash` 对 `curl https://example.com`、`open -a Safari`、`cat /etc/passwd`、`tee /Users/lzf/outside.txt`、`cp src/a.ts /Users/…/a.ts`、`ssh root@example.com`、`git clone https://github.com/foo/bar` 全部返回 `null`（放行）；文件工具路径只经 `outsideWorkdir` 限制在 worktree；`src/worker.ts` 的 env 来自全局 `worker.envAllow`；`tasks` 表没有能力或审计字段。

## 2. 目标

- 每个任务有明确的能力清单：可读目录、可写目录、可继承的环境变量名、可访问域名、是否允许 GUI、额外拒绝的命令。
- 能力按仓库配置、按任务生效；任务创建时快照，运行期以快照为准，配置改动不追溯运行中的任务。
- 默认拒绝，显式放行：未声明目录、域名、环境变量、GUI 一律不可用。
- 越界调用被拒绝并写入任务审计；任务记录能回答「拦了什么、为什么」。
- GUI 是独立布尔开关，不被其它放行项隐式打开。

## 3. 用户故事

### US-1 运维者

作为运维者，我查看任务时能看到它声明的可读/可写目录、环境变量名、域名与 GUI 开关，以及运行中被拦下的调用，不需要翻日志猜。

### US-2 仓库维护者

作为仓库维护者，我在 `repos[].capabilities` 里给某个仓库放行共享目录、测试密钥与接口域名；其它仓库仍保持默认拒绝。

### US-3 单次任务发起人

作为本地操作者，我用 CLI 为一次任务追加放行（例如临时读取 `/data/fixtures`、访问 `api.example.com`），该放行只属于这个任务。

### US-4 Worker

作为 Worker，我在启动时拿到能力清单，prompt 与运行时环境一致；越界时收到明确中文原因，而不是语义模糊的通用失败。

## 4. 需求

能力清单字段固定为六项，全部默认关闭：

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `read` | 额外可读目录；相对路径按仓库根解析 | 空，只允许 worktree 与系统临时目录 |
| `write` | 额外可写目录；相对路径按仓库根解析 | 空，只允许 worktree 与系统临时目录 |
| `env` | 额外允许从父进程继承的环境变量名（密钥只从这里进子进程） | 空，仅 `worker.envAllow` |
| `domains` | 允许访问的主机名，精确匹配 | 空，网络命令一律拒绝 |
| `gui` | 是否允许图形界面 | `false` |
| `blocked` | 额外拒绝的命令，按空格分词后的前缀匹配 | 空 |

| ID | 需求 |
| --- | --- |
| FR-001 | `worker.capabilities` 与 `repos[].capabilities` 使用同一 schema；仓库配置叠加在全局之上，不覆盖默认拒绝 |
| FR-002 | 任务创建时把生效能力快照写入任务记录；续跑、PR 评论续跑、CLI 新任务同样快照 |
| FR-003 | CLI `task` / `continue` 支持 `--cap-read`、`--cap-write`、`--cap-env`、`--cap-domain`、`--cap-block`（逗号分隔）与 `--cap-gui`；只影响本次任务 |
| FR-004 | Worker 子进程环境变量只按能力清单里的名字从父进程复制；能力清单以 `PISA_CAPABILITIES` JSON 与 `PISA_CAP_GUI`（`1`/`0`）传给 Worker 侧 guard |
| FR-005 | 启动时为每个仓库打印生效能力：环境变量名、可读目录、可写目录、域名、GUI、额外拒绝；并打印内置 blocked commands |
| FR-006 | 文件工具路径：读工具必须落在可读目录，写/编辑工具必须落在可写目录；未知工具按写工具处理 |
| FR-007 | bash 写入目标（`rm`、`mkdir`、`touch`、`chmod`、`chown`、`tee`、重定向、`cp`/`mv`/`ln` 目的路径）必须落在可写目录；`cp`/`mv`/`ln` 源路径必须先可读 |
| FR-008 | bash 读取命令（`cat`、`head`、`tail`、`grep`、`rg`、`ls`、`find`、`sed`、`awk` 等）的绝对路径、`~` 路径与 `..` 路径必须落在可读目录 |
| FR-009 | 网络命令（`curl`、`wget`、`ssh`、`scp`、`nc`、`telnet`、`ping`、`dig`、`nslookup`）与 `git clone`/`fetch`/`pull`/`ls-remote`/`submodule` 的显式 URL/主机名必须精确命中 `domains`，未声明时拒绝；git 远端别名（如 `origin`）无法从文本还原主机，不做域名校验（见非目标） |
| FR-010 | `gui=false` 时拒绝 `open`、`osascript`、`xdg-open` 等 GUI 启动命令；`gui=true` 只解除这一类，不改变其它能力 |
| FR-011 | 越界调用返回中文原因，写入任务日志（`guard` 阶段）并追加到任务审计；审计只保留最近 50 条 |
| FR-012 | 任务 JSON（CLI `--json`、Web `/api/tasks` 与任务详情）包含能力快照与审计；`pisa show` 人类输出显示能力摘要与审计条数 |
| FR-013 | 旧任务没有能力快照时，按当前配置解析；旧库自动补 `capabilities`、`audit` 列，不破坏已有任务 |
| FR-014 | 保留既有拦截（git push、reset --hard、clean -f、切分支、worktree remove/prune、branch -D、rebase、commit --amend、sudo、删除根目录、改 `/etc` 权限），默认下 `rm -rf /tmp/x` 仍放行 |

## 5. 验收

1. 默认配置下：`curl https://example.com`、`open -a Safari`、`cat /etc/passwd`、`echo x > /Users/…` 被拒绝；`cat src/a.ts`、`rm -rf /tmp/x` 放行
2. 显式放行后：声明 `domains: ["example.com"]` 时 `curl https://example.com` 放行、`curl https://other.com` 仍拒绝；`gui: true` 时 `open -a Safari` 放行
3. 声明 `read: ["/data/fixtures"]` 时 `cat /data/fixtures/x` 放行、`cat /etc/passwd` 仍拒绝；声明 `write: ["/data/out"]` 时 `echo x > /data/out/f` 放行、`echo x > /data/other/f` 拒绝
4. `blocked: ["npm publish"]` 拒绝 `npm publish --tag x`，放行 `npm run build`
5. Worker 子进程只能看到能力清单里的密钥变量；`PISA_CAPABILITIES` 含生效目录、域名、GUI 与额外拒绝
6. 被拦调用出现在任务审计（`tasks.audit`）、`pisa show` 的审计行与任务日志
7. 运行 `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 不提供容器或操作系统级沙箱；guard 仍是文本级拦截，脚本包装、编译型程序直接写文件不在覆盖范围
- 不推断包管理器注册表域名；`npm install` 这类隐式网络访问不按 `domains` 校验
- 不解析 git 远端别名：`git fetch origin` / `git pull` 不带显式 URL 时不做域名校验
- 不做端口、路径、HTTP 方法级网络规则
- 不实现 GUI 自动化代理；GUI 开关只决定能否启动本机图形程序
- 不改变任务状态机、调度、交付与撤销语义
