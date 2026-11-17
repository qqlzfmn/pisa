# 014 · 实施计划

## 结构

新增一个策略模块，其余模块只做接线。能力是纯数据：解析一次、落库一次、下发一次，运行期只读。

```
src/capabilities.ts     能力类型、解析、env 生成、tool_call 判定（唯一策略点）
src/config.ts           capabilities（全局/档案）、RepoConfig.capabilities、ScheduleJob.capabilities
src/types.ts            IncomingMessage.capabilities（任务级覆盖）、Task.capabilities（快照）
src/store.ts            tasks.capabilities 列 + task_audit 表 + setCapabilities/recordAudit/auditOf
src/router.ts           接单时解析并落库；执行时下发；blocked 事件写审计
src/worker.ts           env 换成 capabilityEnv，无快照拒绝启动
src/adapters/omp.ts     提示词写能力边界；工作目录外的放行目录转 --add-dir
src/adapters/types.ts   AdapterInput.capabilities
extensions/pisa-worker.ts  读 PISA_CAPABILITIES，调 checkToolCall，拒绝即 block
```

## 关键决策

- **快照在接单时生成**：任务记录先于执行回答「它能碰什么」，也避免执行期改配置造成前后不一致；升级前的旧任务在执行前补算。
- **策略判定放在 src，扩展只调用**：判定是纯函数，可在 bun test 里直接覆盖默认拒绝与显式放行两条路径；扩展不再自己维护 `DENY` 正则，避免两套规则。
- **env 改为白名单**：父进程全量 env 是目前最大的信息泄漏面；`PISA_TELEGRAM_TOKEN` 属于 pisa 自己，不该进 Worker。omp 凭据走 `~/.omp/agent`，不依赖 env。
- **GUI 单开关**：GUI 与网络、目录是不同维度，`gui: true` 只放开 GUI 工具与 GUI 命令。
- **域名只管显式主机**：从 URL 与 `ssh/scp/rsync` 目标提取主机；`git fetch origin` 这类远端名由仓库配置决定，`domains` 非空即放行。包管理器与 MCP 是明确的非目标。
- **顺带修一个既有 bug**：`Task` 字面量里多写了 `capabilities` 之外的字段没有；`src/adapters/omp.ts` 原本把 `task.capabilities` 当上下文条件（该字段当时不存在），本次改为按快照输出能力段。

## 步骤与验证

1. 新增 `src/capabilities.ts` → 验证：`bun test tests/capabilities.test.ts` 覆盖解析、路径、域名、GUI、env
2. 配置与类型接线 → 验证：`bunx tsc --noEmit`
3. Store 迁移、审计表 → 验证：任务记录测试断言快照与审计顺序
4. Router 接单/执行/审计 → 验证：router 集成测试用 fake worker 写 blocked 行，断言 `auditOf` 有记录、快照下发
5. Worker env 与 adapter `--add-dir` → 验证：adapter 测试断言 `--add-dir /tmp/shared`；`sh -c env` 冒烟证明密钥被过滤
6. 扩展改为调用策略 → 验证：扩展测试用 fake `pi` 断言默认策略拦截网络命令/GUI，放行后不拦截
7. 文档：spec、README、`pisa.config.example.json`

## 全量验证

- `bun test`（8 个文件）
- `bunx tsc --noEmit`
- 冒烟：以 `command: "sh", extraArgs: ["-c", "env"]` 跑一次 Worker，确认 `PISA_TELEGRAM_TOKEN` 不再出现、`PISA_CAPABILITIES` 出现
