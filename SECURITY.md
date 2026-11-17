# 安全策略

## 支持范围

只有 `main` 上的最新代码接受安全修复。没有 LTS 分支，版本号以 `package.json` 的 `version` 为准。

## 信任边界

pisa 会把自然语言需求变成真实命令执行。谁能送进需求，谁就间接获得了执行能力。

| 入口 | 鉴权方式 | 边界说明 |
| --- | --- | --- |
| Telegram / CLI | `whitelist.users` 精确匹配 `userId` | 不在白名单的用户一律拒绝（`src/router.ts` 的 `checkAccess`），并做 24 小时一次的拒绝回复 |
| 仓库范围 | `whitelist.repos` 匹配 `repos[].alias` | 白名单用户也只能操作列出的仓库；路径必须是 git 仓库 |
| webhook | 只监听 `127.0.0.1`，校验 `x-pisa-token` 请求头 | 不对外网暴露；没有时间戳与签名，依赖回环地址和共享 token。投递的消息以 `webhook.userId` 走 `checkAccess`，该 id 必须在 `whitelist.users` 里，否则被拒；去重（`store.claimEvent`）在鉴权之前，被拒事件的 `eventId` 已占位，重投不会再生效 |
| GitHub 评论 | 无作者鉴权 | 能在被监听的仓库里评论的人，就能用 `/pisa ...` 派活；任务归属取配置里的 `chatId` / `userId`。只把可信或私有仓库放进 `github.repos` |

Agent 的执行权限：

- Worker 以 pisa 进程所属的**系统用户身份**启动子进程（`src/worker.ts` 的 `Bun.spawn`），工作目录是该任务的 git worktree。它能读写该用户可访问的任何文件，能发起网络请求。
- `extensions/pisa-worker.ts` 里的 `DENY` 正则会拦下 `git push`、`git reset --hard`、`git clean -f*`、`rm -rf /`（`/tmp` 除外）、`sudo`、对 `/etc` 的 `chmod` / `chown`。这是**误触防护，不是沙箱**：它是命令字符串匹配，换一种写法就能绕过。
- 需要隔离时用系统手段：专用低权限账号运行 pisa、放进容器或虚拟机、不要在该用户环境里放生产凭据。

## 密钥与数据

- 配置里只写环境变量名（`channels.telegram.tokenEnv`、`webhook.tokenEnv`、`github.tokenEnv`），不存值。值来自环境变量；`scripts/supervise.sh` 在变量缺失时读 `~/.pisa/telegram_token` 与 `~/.pisa/webhook_token`。
- `pisa.config.json`、`.pisa/`、`*.db` 已在 `.gitignore` 中。不要提交或外发。
- `.pisa/` 下有 SQLite 状态库、任务日志、进度文件与工作副本，可能包含 prompt 原文和命令输出。
- 日志与摘要会经过 `src/log.ts` 的 `redact`：按模式替换 Telegram bot token、`ghp_/gho_/ghu_/ghs_/ghr_`、`sk-` 开头的 key、以及 `token= / password: / api_key=` 这类赋值形态。**模式匹配不保证覆盖自定义格式**，不要依赖它兜底，输入侧就不要把密钥写进 prompt 或命令。
- Agent 产出的代码默认不可信：合入 `main` 前必须人工评审。

## 上报漏洞

**不要开公开 Issue。** 用 GitHub 仓库 Security 标签页的 *Report a vulnerability*（Security Advisories）私密上报；这条通道不公开内容，修复完成后再协商披露。

上报内容尽量包含：

- 受影响的提交或版本
- 复现步骤与最小输入（脱敏后的配置片段）
- 影响：能读取什么、能执行什么、需要什么前提（例如白名单用户、本机访问、仓库评论权限）
- 可选的修复方向

收到后会先在 advisory 里确认，修复与验证在同一 advisory 内跟进。

## 不在范围内

- 上游项目缺陷：pi / omp 运行时、Telegram、GitHub 平台本身的问题，请报给对应上游
- 使用方自己的配置与仓库内容：白名单里放了不可信用户、把 pisa 跑在高权限账号下、仓库本身含密钥
- Agent 生成的代码是否安全：这属于评审责任，不是本项目的漏洞
- 已公开的依赖 CVE 但没有可用修复的情况（会记录在 CHANGELOG 的 `Security` 段）
