# 016 · 实施计划

## 1. 结构

README 只承担「判断 + 上手」：定位、读者路径、演示、是什么、30 秒上手、架构、场景、边界、FAQ、限制、文档地图、开发与许可。所有配置项、命令细节、事件入口、撤销、保留、launchd 迁到 `docs/operations.md`，README 用一张文档地图指向它。

理由：首页长度与信息密度成反比。配置必须准确，但只有装完的人才需要；把人留在首页的成本远高于多一次跳转。

## 2. 关键取舍

| 决策 | 备选 | 理由 |
| --- | --- | --- |
| 新增 `LICENSE`（MIT） | 不加许可证、只放徽章 | 徽章必须有落点；MIT 与项目「自托管小工具」的定位一致，改动只加一个文件 |
| 架构图用 mermaid | ASCII 图 | 原 ASCII 图讲的是参考架构（Router + N 个 pi Worker），与现实现不一致；mermaid 能画出入口→core→runtime 的真实边界，且 GitHub 原生渲染 |
| 场景 1 用 stub worker 录制 | 真实 omp 全流程 | 真实任务要几十秒模型时间，GIF 会变成「等待」；stub 只替换 agent 进程，daemon、通道、回执、worktree、分支全是真实链路，README 已标注 |
| 演示产物用 GIF | asciinema | 本机没有 asciinema/agg；GIF 在所有 README 查看器上都能直接播放 |
| 链接测试覆盖全部 Markdown | 只测 README | 同一份代码几行的事，能防住 `docs/` 与 `docs/specs/` 的死链 |

## 3. 演示录制链路

1. 在临时目录初始化 git 仓库，配置 `pisa.config.json` 指向它
2. 用 `fake-omp` 顶替 `omp`：按 adapter 期望输出 `message_start` / `message_end` JSON，向 `PISA_PROGRESS_FILE` 追加进度，并真实改一个文件
3. `script -q` 起 pty（Bun 重定向到文件时是块缓冲，收不到完整回执），stdin 用 FIFO 保持不关闭，顺序注入 `/status`、`/pisa …`、`/status`
4. python + PIL 把终端输出逐行渲染成 940×600 深色帧，合成为 GIF
5. GIF 落 `docs/assets/demo.gif`，README 图下注明 stub worker

## 4. 事实来源

- 命令回执格式、状态机、进度事件：`src/router.ts`、`src/adapters/omp.ts`
- 环境变量白名单、并发默认值：`src/config.ts`（`DEFAULT_ENV_ALLOW`、`DEFAULT_CONFIG`）
- webhook 响应体与鉴权：`src/index.ts`
- GitHub 评论续跑与回帖格式：`src/router.ts`、`src/github.ts`
- 云平台边界：CNB「NPC 事件」文档（委托代理模型、工作模式）、GitHub「About Copilot cloud agent」文档（Actions 环境、一任务一 PR、59 分钟上限）

## 5. 风险

- **徽章长期停在「no status」**：main 上还没有 CI 运行记录；一旦推送触发 CI 就会转绿，不改代码
- **GIF 体积**：控制在 50 KB 内，避免仓库首页加载变慢
- **文档漂移**：`docs/operations.md` 与 `pisa.config.example.json` 同源，后者是唯一字段清单；链接测试只能防死链，防不住语义漂移

## 6. 验证

- `tests/docs-links.test.ts`：相对链接有落点；README 锚点落在真实标题
- mermaid 图提交前用渲染服务校验一次语法
- 30 秒上手在干净副本上原样执行，检查分支与改动
