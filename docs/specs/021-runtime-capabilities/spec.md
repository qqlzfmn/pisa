# 021 · Runtime 能力清单

- 状态：implemented
- 关联：012（命令守卫）、014（Worker 环境白名单）、020（合并前校验隔离）
- 依赖：无

## 1. 问题

Worker 以运维身份裸跑：子进程只继承 `DEFAULT_ENV_ALLOW`，`guard` 只拦一份全局固定的 denylist 和「工作目录之外的路径」。其余能力没有任何声明或记录：

- 读哪些目录（例如 `~/.ssh`、宿主机配置）不在拦截范围
- 能用哪些密钥由全局 `worker.envAllow` 决定，与仓库无关
- 能否访问网络、访问哪些域名没有约束（`curl` 可以任意出网）
- 是否允许 GUI 自动化没有开关
- 任务结束后，`pisa show` 答不出「这次跑了什么能力、拦了什么」

复现：`tests/worker.test.ts` 已证明子进程拿不到 `SECRET`；`tests/guard.test.ts` 已证明 `git push`、越界 `-C` 被拦。反向没有覆盖：`curl https://any`、`open`、`write` 到 `~/.ssh` 都不触发任何拦截，任务记录里也没有能力的字段。

## 2. 目标

- 能力按仓库声明、任务启动时解析成清单，配置可全局默认、按仓库覆盖
- 清单在启动时可见：env、可写目录、被禁命令
- 越界调用被守卫拒绝，拒绝事件与原因进入任务记录（审计）
- 默认拒绝：未声明的目录、密钥、域名、GUI 一律不可用
- GUI 是独立开关，默认关闭
- 默认路径与放行路径都有测试

## 3. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 配置新增 `capabilities`（全局）与 `repos[].capabilities`（按仓库）；字段 `read`、`write`、`env`、`domains`、`gui`、`blocked` |
| FR-002 | 纯函数 `resolveCapabilities(source, repo)` 合并两处声明：数组取并集去重，`gui` 取仓库覆盖全局，缺省 `false` |
| FR-003 | `capabilityManifest()` 把相对路径按任务工作目录解析成绝对路径，工作目录本身恒在 `read`/`write` 中；`env` 为 `worker.envAllow` 与声明密钥的并集 |
| FR-004 | `Worker.run` 用清单的 `env` 构造子进程环境，并把整份清单序列化到 `PISA_CAPABILITIES` 供守卫使用 |
| FR-005 | 启动时每个仓库打印一行 `[pisa] 能力清单 · <仓库> · env=… · read=… · write=… · domains=… · gui=… · blocked=…`，与 `Worker.run` 用同一函数计算 |
| FR-006 | 守卫扩展读取 `PISA_CAPABILITIES`；`gui: false` 时拒绝 GUI 工具（名称含 computer/screenshot/browser/playwright/puppeteer/chrome-devtools/pencil） |
| FR-007 | 文件类工具的目标路径必须落在 `write`（写类工具）或 `read`（其余）声明的根目录内；未声明根目录时只允许工作目录 |
| FR-008 | bash 侧：`blocked` 追加禁止命令（首段精确匹配）；`gu <ref>`、`open` 等 GUI 命令在 `gui: false` 时拒绝；`curl`/`wget` 的目标域名必须在 `domains` 内，无法解析域名或未声明即拒绝 |
| FR-009 | 每次拒绝写入 progress `{type:"blocked", tool, detail, reason}`；任务结束后收集为 `Task.audit.violations` 随结果落库 |
| FR-010 | `WorkerResult.audit = { capabilities: manifest, violations: violation[] }`，最多保留 100 条违规 |
| FR-011 | `pisa show` 在任务有审计时输出一行能力与拦截摘要 |
| FR-012 | 未配置 `capabilities` 的项目行为不变：denylist、工作目录边界、`worker.envAllow` 与升级前一致；GUI 默认拒绝属于本次收紧，文档说明 |

## 4. 验收

1. 默认配置下 `resolveCapabilities` 返回空数组、`gui: false`；子进程 env 只有默认白名单，`PISA_CAPABILITIES` 中 `gui: false`、`env` 不含密钥
2. 仓库声明 `env: ["GH_TOKEN"]` 后子进程拿到 `GH_TOKEN`；未声明的密钥仍不可见
3. `gui: false` 时 `open`、GUI 工具被拒绝；`gui: true` 时放行
4. 声明 `domains: ["api.github.com"]` 时 `curl https://api.github.com/x` 放行，`curl https://evil.com` 拒绝，`curl --version` 因无法核对域名拒绝
5. `write` 未声明的路径（如 `/etc/hosts`）被拒绝，声明目录内放行
6. 任务结果带审计，`store` 读回同一份；`pisa show` 有一行摘要
7. `bun test` 与 `bunx tsc --noEmit` 通过

## 5. 非目标

- 内核级隔离（容器、seatbelt、namespace）：守卫仍是进程内的工具调用检查
- 按任务单独声明能力：任务继承仓库声明
- 域名解析后的 IP 级校验、HTTP 方法级校验
- `/pisa merge` 校验子进程的能力清单：仍用 `worker.envAllow`
