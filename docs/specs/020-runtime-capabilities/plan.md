# 020 · 方案

## 1. 数据模型

`src/capabilities.ts` 是唯一真相源：

```ts
interface CapabilitySpec { read?, write?, secrets?, domains?, gui?, deny? }
interface RuntimeCapabilities {
  workdir: string;
  read: string[]; write: string[]; secrets: string[];
  domains: string[]; gui: boolean; deny: string[];
  blocked: string[]; // 展示给 Worker 的生效禁止项
}
```

`resolveCapabilities(workdir, repoPath, spec)`：

- workdir 绝对化，始终进入 `write` 与 `read`
- `spec.write` 相对仓库根解析后并入 `write`，`spec.read` 再并入 `read`
- `domains` 小写、去尾点；支持 `*.example.com`
- `blocked` = 内置禁止项 + `deny` 逐条展开

## 2. 配置与传递

```
Config.capabilities ─┐
RepoConfig.capabilities ─┼─ resolveCapabilities ─→ Worker.run(..., caps)
Task.capabilities ────┘                              │
                                                     ├─ stateDir/runtime/<id>.json
                                                     └─ PISA_CAPABILITIES_FILE
```

优先级用 `task ?? repo ?? global ?? null`，空对象 `{}` 是有效值，表示显式使用默认拒绝。

Webhook 的 `capabilities` 用 `parseCapabilitySpec` 清洗：只接受对象、字符串数组、布尔 `gui`，其余忽略。

数据库 `tasks.capabilities TEXT` 存 JSON；`task_audit` 存审计：

```sql
task_audit(id, task_id, kind, detail, created_at)
```

`kind`：`capabilities`、`blocked`。

## 3. Worker 启动

1. `resolveCapabilities` 在 Router 完成，随 `run()` 传入
2. `Worker` 计算子进程环境：`workerEnv(envAllow ∪ secrets, process.env)` 合并 adapter env
3. 写 manifest：生效能力 + `env: Object.keys(childEnv).sort()`
4. 扩展初始化时读 `PISA_CAPABILITIES_FILE`，读不到就退回 `defaultRuntime(PISA_WORKDIR)`（默认拒绝）

## 4. guard

`blockBash(cmd, workdir, caps = defaultRuntime(workdir))`，判定顺序：

1. 原有破坏性命令（`sudo`、`rm -rf /`、`/etc` 权限）
2. `deny` 前缀
3. git 规则；路径参数改用 `caps.write`
4. GUI 命令：`caps.gui` 为 false 时拒绝
5. 联网命令：解析目标域名，逐个对 `caps.domains` 校验；`file://` 按读路径校验
6. 重定向目标：对 `caps.write` 校验
7. 写/读命令的路径参数：对 `caps.write` / `caps.read` 校验
8. 引号内字符串递归

域名解析覆盖：

- URL：`curl`、`wget`、`http`、`https`、`git clone`、`git submodule add`
- scp 形态：`ssh`、`scp`、`sftp`、`rsync` 的 `user@host:path`
- 纯主机：`nc`、`netcat`、`telnet`
- `gh`：默认 `github.com`，`--hostname` 覆盖

写命令路径处理：

- `cp` / `install`：`-t`/`--target-directory` 为写目标，其余为读源；无 `-t` 时最后一个路径为写目标
- `dd`：`if=` 读、`of=` 写
- 其余：所有非选项路径按写目标

## 5. 审计

`watchProgress` 拆成 `{ flush, stop }`：

- 每 2 秒读新增行，`blocked` 一律写 `task_audit`
- `notifications.progress` 只控制是否推送到聊天
- Worker 返回后 `flush()` 再 `stop()`，避免最后一行丢失

任务开始写 `kind=capabilities` 审计，内容为生效能力策略（不含环境变量键名）；环境变量键名只在 runtime manifest。

## 6. 兼容性

- `blockBash` 第三参可选，旧调用默认 `defaultRuntime(workdir)`：此前允许的网络/GUI/越界写会改为拒绝，这是本次行为变更
- `Task.capabilities`、`AdapterInput.capabilities` 可选，旧测试字面量不需要全量补字段
- `WorkerRunner.run` 新增可选参数，测试替身可忽略

## 7. 风险

| 风险 | 处理 |
| --- | --- |
| 路径解析误判选项值（如 `head -n 5` 的 `5`） | 相对路径仍落在 workdir，不会误拒；只对绝对路径敏感 |
| `grep`/`rg` 可读任意路径 | 明示非目标，不假装覆盖 |
| 脚本包装可绕过 | 明示非目标；审计只记录被 guard 看见的命令 |
| `envAllow` 仍可全局放行密钥 | 文档说明：能力里的 `secrets` 是追加，收紧要从 `envAllow` 移除 |
