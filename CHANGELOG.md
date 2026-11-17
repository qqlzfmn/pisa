# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

只记用户可见的变化：能力、行为、接口、配置、安全修复。内部重构与文档措辞不单独成条。未发布的改动放在 `Unreleased`，发版时补日期并新建版本段。

## [Unreleased]

### Added

- CI：`push` 与 `pull_request` 上依次跑 `bun install --frozen-lockfile`、`bun test`、`bunx tsc --noEmit`（`.github/workflows/ci.yml`）
- Issue 表单：Bug 报告（复现步骤、期望、实际、环境、影响范围）与功能建议（问题、期望效果、影响范围）（`.github/ISSUE_TEMPLATE/`）
- PR 模板：目的、背景、方案、影响与风险（含回滚方式）、验证结果与自查清单
- `CONTRIBUTING.md`：环境要求、启动方式、常用命令、规格驱动流程、分支与提交规范、PR 前必跑检查
- `SECURITY.md`：信任边界（触发入口、Agent 执行权限）、密钥与日志脱敏、私密上报通道

### Changed

- README 去掉「测试 89 个全绿」这类硬编码计数，改为不随测试数量漂移的表述；新增指向 CONTRIBUTING 与 SECURITY 的入口

## [0.1.0]

`package.json` 当前版本，未打 tag。

### Added

- Router–Worker 最小闭环：消息 → 鉴权 → 建任务 → 独立 git worktree → Worker 执行 → 提交到 `pisa/<任务号>` → 回执（001）
- 多 Worker 并行：并发上限可配，任务级隔离，`/pisa status` 查看（002、010）
- 进度上报（`🛠 命令` / `✏️ 文件`）、Agent 内命令拦截、分支续跑、webhook 事件入口（003）
- 订阅绑定：回复任务消息即续跑；群聊关键词与定时探针主动发现；Worker 适配器可替换；交付 push 与 PR（004）
- 崩溃自愈：重启后中断任务转 `paused` 可 `resume`，缺工作副本或会话的标 `failed`；任务级超时（005）
- GitHub PR 评论触发任务：轮询、去重、接续原 PR 分支、完成后回帖（006）
- GitHub Issue 评论触发任务：从主干开新分支，新建 PR 正文附 `Closes #<n>`（007）
- IM 多仓库路由：`@别名` 指定仓库，别名写错不丢正文（008）
- 定时任务：5 段 cron，同一分钟只投一次，`/pisa schedules` 查看（009）
- GitHub 评论多仓库轮询：按仓库隔离增量下界，单仓库失败不拖累其它（011）
- 命令误触防护：错拼命令只回复建议、单英文词要求 `/pisa confirm`、启动时注册 Telegram 命令菜单（012）
- 任务撤销 `/pisa rewind`：只读预览、`--yes` 执行，已合并任务用 revert 回退（013）
- 常驻运行：`scripts/supervise.sh` 崩溃重启，launchd 开机自启（`scripts/install-launchd.sh`）
