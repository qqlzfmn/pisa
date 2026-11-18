# 安全策略

## 前提

pisa 是单机自托管工具。Worker 以运行 pisa 的那个用户身份执行任意命令：没有容器、没有资源配额。能力清单（`worker.capabilities` / `repos[].capabilities` / `repos[].profiles`）在命令级默认拒绝越界的读写、域名与 GUI 操作，扩展里的 guard 还拦截少数破坏性命令；两者都是尽力而为的防线，不是沙箱。

能力边界（无操作系统沙箱、回滚不完整、单机、并发、鉴权面）的完整描述只有一处：[docs/usage.md §能力边界](./docs/usage.md#能力边界)。本文只写信任面划分与上报流程。

**结论：只在受信机器上、只对源码可信的仓库启用。** 把不可信仓库写进 `repos` 等于把任意代码执行的权限交给它。

## 信任边界

| 入口 | 谁被信任 | 拒绝方式 |
| --- | --- | --- |
| IM（私聊 / 群聊） | `whitelist.users` 与 `whitelist.repos` 双重白名单 | 未授权用户不建任务，24 小时内只提示一次 |
| webhook（`POST /event`） | 只监听 `127.0.0.1`；请求头 `x-pisa-token` 必须等于环境变量里的 token | 不匹配返回 403 |
| GitHub 评论 | 只处理正文以 `/pisa ` 开头的评论；**评论作者不参与鉴权** | 不符合前缀一律忽略 |
| 定时任务 / 探针 / 关键词 | 配置里的 `chatId` / `userId`，同样走白名单 | 身份或配置缺失则不触发 |
| Worker 执行 | 运行用户权限；能力清单默认拒绝越界读写/域名/GUI，guard 拦截破坏性命令与 workdir 外路径 | 见 [014 规格](./docs/specs/014-worker-guard/spec.md) 与 [019 规格](./docs/specs/019-runtime-capabilities/spec.md) |
| 交付 | 开启 `delivery.push` / `delivery.pr` 才有远程副作用 | 关闭时改动只留在本地分支 |

## 已知不防护

- **guard 可绕过**：它做字符串级匹配，覆盖范围以 [014 规格](./docs/specs/014-worker-guard/spec.md) 为准。脚本内部调用、guard 未覆盖的构造、编译好的二进制都能绕开。要强隔离就自己套容器或虚拟机。
- **供应链**：任务会执行仓库里的脚本、构建命令与依赖安装。源码不可信的仓库不要接入。
- **回滚不完整**：`rewind` 只撤销账本内的副作用（PR、分支、工作副本、合并提交）。任务期间的外部调用（API、消息、数据库、部署）撤销不了。
- **状态目录不是多进程安全的**：同一份 `stateDir` 只应有一个 pisa 进程。
- **日志脱敏只覆盖已知形态**：`src/log.ts` 遮蔽 Telegram bot token、`token=` / `password=` / `secret=` / `api_key=` 赋值、`ghp_…` 类 GitHub token、`sk-…` 类密钥。其他形态（自己起的变量名、URL 里的凭据、路径里的用户名）不会被遮蔽。粘贴日志到 Issue 或共享文档前自己再删一遍。

## 密钥

- token 只从环境变量或 `~/.pisa/` 下的文件读取，不写进 `pisa.config.json`，也不进 launchd plist。
- `gh` 只认 `GH_TOKEN` / `GITHUB_TOKEN`；配置里的 `tokenEnv` 指定从哪个环境变量转交。
- 配置文件和日志都进过 `.gitignore`，提 PR 前确认没有夹带。

## 上报漏洞

**不要开公开 Issue。** 公开的复现步骤等于给所有部署者一个现成的攻击面。

首选 GitHub 私有漏洞报告：维护者在仓库 Settings → Code security 里开启 Private vulnerability reporting 后，Security 标签页的「Report a vulnerability」可用。

该功能未开启时，开一个不含细节的 Issue，只说明「想私下报告安全问题」，维护者会给出通道。

报告里请给：

- 版本（`package.json` 的 version 或 commit 短哈希）
- 运行平台与 `bun --version`
- 触发通道（IM / webhook / CLI / 定时 / GitHub 评论）
- 复现步骤与最小配置（隐去 token）
- 影响面：能越权到哪一步、能否读到密钥、能否绕开 guard

## 支持版本

| 版本 | 支持 |
| --- | --- |
| 0.1.x | 支持，只对最新版本修安全问题 |

没有 LTS 分支；旧版本的问题以升级到最新版本为修复方式。
