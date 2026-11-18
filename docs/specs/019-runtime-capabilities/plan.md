# 019 · 实施计划

## D1 能力是数据，判定是纯函数

`src/capabilities.ts` 只做「解析 / 合并 / 序列化」，不碰进程；`extensions/guard.ts` 只做「拿策略判命令」。两边用同一个 `Capabilities` 形状，Worker 写盘、扩展读 env，不存在第二份口径。

`guard.ts` 不 import `src/capabilities.ts`：扩展要能独立加载，且 `capabilities.ts` 需要 guard 的规则描述生成 blocked 清单，反向依赖会成环。`Capabilities` 里只有 `readPaths/domains/gui` 对 guard 有意义，`GuardPolicy` 在 guard 内单独声明为这三个字段的可选版本。

## D2 隐含范围：workdir 与临时目录

默认拒绝不能把 `/tmp` 也堵上：子进程的 `TMPDIR`、构建工具、现有 `rm -rf /tmp/x` 行为都依赖它。可写目录 = 工作目录 + `os.tmpdir()` + `/tmp` + `/private/tmp`（macOS 的 `/tmp` 是符号链接，两边都算）。读取判定额外放行 `AMBIENT_READ_ROOTS`：`/bin`、`/sbin`、`/usr`、`/lib`、`/lib64`、`/opt`、`/System`、`/Library`、`/etc/ssl`、`/dev`、`/tmp`、`/private/tmp`、`/var/folders`、`/private/var/folders`。

理由：执行任何命令都要读系统目录里的二进制和库；把这些做成可配置只会让默认配置自己不可用。用户数据目录（`/Users`、`/home`、`/etc`、`/var`、`/root`）不在隐含范围，必须显式写进 `readPaths`。

## D3 判定顺序与粒度

每个 shell 段依次判：既有规则（提权、删根、改 `/etc` 权限、git 危险操作）→ GUI 命令 → 写入目标（重定向、写类命令的位置参数）→ 读取路径（绝对 / `~` / 含 `/` 或 `.` 的词）→ 网络目标（命令头或任意 `scheme://` 词）。

先判写入再判读取：`rm /Users/x` 应报「写入范围之外」，而不是「读取范围之外」。重定向到 `/dev/null` 等设备不算写入目标。

没有静态目标的网络命令（`curl` 无参数、`ssh` 无主机）按拒绝处理——无法确认目标就不放行。

## D4 档位替换而非叠加

`profiles.<name>` 存在时整体替换仓库 `capabilities`，再与 `worker.capabilities` 合并。叠加会让「临时收紧」做不到（并集只能加），替换语义更容易解释：仓库写基线，档位写差异化的完整清单。

## D5 审计走既有任务日志

`WorkerResult.blocked` 由 Worker 在进程结束后从 progress jsonl 汇总，Router 逐条 `TaskLogger.write("blocked", …)`。不新增审计表：任务日志已经是「任务记录」，`pisa logs <id>` 能直接看到，回执也能带上次数。

Progress 事件仍然实时推送（`progressOn`），审计不依赖它——关掉进度推送后拒绝记录照样进任务日志。

## D6 密钥只按名字

`secrets` 是 env 名列表，值来自 pisa 自身环境。清单文件与 `PISA_CAPABILITIES` 只写名字，不写值；任务日志同样只记名字。
