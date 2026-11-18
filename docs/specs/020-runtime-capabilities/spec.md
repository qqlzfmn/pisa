# 020 · Runtime 能力清单

- 状态：implemented
- 关联：014（Worker 边界 guard）、014（Worker 环境变量白名单）
- 依赖：无

## 1. 问题

Worker 以 pisa 进程的用户身份裸跑，边界只有一张全局 DENY 列表。能碰什么没有声明，也没有记录：

- 配置里没有「这个任务能读哪些目录、用哪些密钥、访问哪些域名、能不能开 GUI」的字段
- `extensions/guard.ts` 只拦 git 破坏性命令、`sudo`、`rm -rf /`、改 `/etc` 权限；网络与 GUI 完全不拦
- bash 写文件不校验目录：文件工具检查 `path`，`echo x > /tmp/out`、`cp /etc/passwd /tmp/x`、`touch ../outside` 全部放行
- 被拦下的命令只进 TaskLogger，任务记录里查不到
- 出事后无法回答「这个任务当时能碰什么」

复现（改动前）：

```text
$ bun -e 'import {blockBash} from "./extensions/guard"; ...'
"curl https://evil.example/x" => null
"open https://evil.example" => null
"wget http://169.254.169.254/latest/meta-data" => null
"osascript -e \"display dialog 1\"" => null
"echo x > /tmp/out" => null
"cp /etc/passwd /tmp/x" => null
"touch ../outside" => null
```

`null` 表示放行。前四条说明没有域名/GUI 边界，后三条说明 bash 可以任意写。

## 2. 目标

- 每个任务有一份显式能力清单：可读目录、可写目录、可用密钥、可访问域名、GUI 开关、额外禁止命令
- 默认拒绝：没写的目录不可读写，没写的密钥不进环境，没写的域名不能联网，GUI 默认关闭
- 启动时把实际生效的能力写成 manifest（含子进程环境变量键名），供排查
- 越界命令被 guard 拒绝，并写入任务记录（SQLite 审计表 + 任务日志）
- GUI 是独立开关，不与网络权限捆绑

## 3. 用户故事

### US-1 声明任务能力

作为 pisa 的使用者，我在仓库配置或 webhook 任务里写 `capabilities`，声明这个任务能读 `/data`、能联网到 `github.com`、能用 `GH_TOKEN`，Worker 只拿到这些。

### US-2 默认拒绝

作为 pisa 的维护者，任务没有声明 `domains` 时，`curl https://evil.example` 被拒绝；没有开启 `gui` 时，`open`/`osascript` 被拒绝；没有声明可写目录时，bash 重定向到 `/tmp` 被拒绝。

### US-3 可回答「它能碰什么」

作为 pisa 的维护者，任务结束后能在任务记录里看到启动时的能力 manifest，以及每条被拒命令的原因。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `src/capabilities.ts`：`CapabilitySpec`、`RuntimeCapabilities`、`defaultRuntime`、`resolveCapabilities`、`parseCapabilitySpec`、`outsideRoots`、`hostAllowed` 均为纯函数 |
| FR-002 | `CapabilitySpec` 字段：`read?: string[]`、`write?: string[]`、`secrets?: string[]`、`domains?: string[]`、`gui?: boolean`、`deny?: string[]`；未知字段忽略 |
| FR-003 | 配置层级：全局 `capabilities` → 仓库 `capabilities` → 任务 `capabilities`，后者整体替换前者，不合并；任务为空对象表示显式收紧到默认值 |
| FR-004 | 相对路径按仓库根解析；workdir 始终可读可写；`write` 自动并入 `read` |
| FR-005 | 默认值：read/write 只有 workdir，secrets/domains/deny 为空，gui 为 false |
| FR-006 | Worker 启动时写 `stateDir/runtime/<taskId>.json`，内容为生效能力加实际子进程环境变量键名；通过 `PISA_CAPABILITIES_FILE` 交给扩展 |
| FR-007 | 子进程环境 = `worker.envAllow` 与 `capabilities.secrets` 的并集，再合并 adapter 注入的 `PISA_*` |
| FR-008 | guard 增加域名检查：`curl`、`wget`、`http(s)`、`ssh`、`scp`、`sftp`、`rsync`、`nc`/`netcat`、`telnet`、`gh`，以及 `git clone`/`git submodule add` 的 URL；域名不在 `domains` 内拒绝，`*.example.com` 匹配子域名 |
| FR-009 | guard 增加 GUI 检查：`open`、`xdg-open`、`osascript`、`screencapture`、`cliclick`、`xdotool`、`wmctrl`；`gui !== true` 时拒绝 |
| FR-010 | guard 增加写路径检查：shell 重定向（`>`、`>>`、`2>`），以及 `cp`、`mv`、`rm`、`mkdir`、`touch`、`tee`、`ln`、`install`、`truncate`、`chmod`、`chown`、`dd of=` 的目标路径必须落在 `write` 内 |
| FR-011 | guard 增加读路径检查：`cat`、`head`、`tail`、`less`、`more`、`stat`、`ls`、`find`、`du`、`file`、`wc`、`cmp`、`diff` 的路径参数必须落在 `read` 内；`grep`/`rg` 因 pattern 与路径不可区分，不在覆盖范围 |
| FR-012 | `deny` 按命令前缀逐词匹配，命中返回拒绝原因；`sudo`、git 破坏性命令等原有规则保留 |
| FR-013 | 文件工具按工具名区分读写：名称命中 `/write|edit|patch|create|delete|remove|move|rename|copy|mkdir|touch/i` 用 `write`，其余用 `read` |
| FR-014 | 被拒命令：扩展 emit `type=blocked`，Router 写入 `task_audit` 表；进度转发仍受 `notifications.progress` 控制 |
| FR-015 | 任务启动时把生效能力（不含环境变量键名）写入 `task_audit`（`kind=capabilities`）；键名见 runtime manifest |
| FR-016 | `tasks` 表增加 `capabilities` 列，任务从 webhook 可携带能力；旧库自动迁移 |
| FR-017 | `watchProgress` 无论 `notifications.progress` 是否开启都要运行，以保证审计；`agent_end` 后补读最后一段 |
| FR-018 | 提示词加入生效能力段，Worker 知道本任务的目录、域名、密钥与 GUI 状态 |

## 5. 验收

1. 不声明能力时，`curl`、`open`、`echo x > /tmp/out` 被拒绝；workdir 内命令照常
2. 声明 `domains: ["example.com"]` 后 `curl https://example.com` 放行，`curl https://evil.example` 仍拒绝
3. 声明 `write: ["/tmp"]` 后 `echo x > /tmp/out` 放行，`cp /etc/passwd /tmp/x` 因读越界拒绝
4. 声明 `gui: true` 后 `open` 放行
5. `stateDir/runtime/<taskId>.json` 存在且含 `read`、`write`、`domains`、`gui`、`env`
6. 任务记录中能查到 `capabilities` 与 `blocked` 审计
7. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 不是沙箱。规则是命令文本层面的启发式，脚本包装、动态拼接、`grep`/`rg` 的路径、包管理器安装脚本仍可绕过；只用于减少误伤与事后追溯。
- 不隔离进程资源、不限制 CPU/内存、不做容器。
- 不改变 git 提交与推送由 pisa 收口的机制。
