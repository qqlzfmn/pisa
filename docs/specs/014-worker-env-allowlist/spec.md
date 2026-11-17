# 014 · Worker 环境白名单

- 状态：implemented
- 关联：001（Worker 进程边界）、006（token 走环境变量）
- 依赖：无

## 1. 问题

Worker 子进程原先继承全部 `process.env`。于是 `PISA_TELEGRAM_TOKEN`、`GH_TOKEN`、`PISA_WEBHOOK_TOKEN` 和模型厂商 key 都会进入一个由提示词驱动的 LLM 进程。任务正文来自 IM、GitHub 评论与探针输出，仓库文件也可能带注入内容；子进程里一条 `env` 或 `curl -d "$(env)"` 就能把凭据带出去。

复现：把 `worker.command` 指向打印环境的脚本，`Worker.run` 的输出里能看到 `GH_TOKEN`、`PISA_TELEGRAM_TOKEN`。

## 2. 目标

- 子进程只拿到显式放行的环境变量，默认只够进程本身运行
- 放行清单可配置，运维需要时显式加键（例如厂商 key）
- 启动日志能核对本次实际放行了哪些变量名
- 适配器注入的 `PISA_WORKDIR`、`PISA_PROGRESS_FILE` 不受白名单影响

## 3. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `worker.envAllow?: string[]`，默认 `DEFAULT_ENV_ALLOW`：`PATH`、`HOME`、`LANG`、`LC_ALL`、`TERM`、`TMPDIR`、`SHELL`、`USER` |
| FR-002 | 纯函数 `workerEnv(allow, src)` 按白名单挑选键：允许且存在才复制，不生成空值 |
| FR-003 | `Worker.run` 用 `workerEnv(cfg.envAllow ?? DEFAULT_ENV_ALLOW, process.env)` 构造继承部分，再合并 `adapter.buildEnv()` |
| FR-004 | 启动时打印 `[pisa] Worker 环境白名单 · <变量名列表>`，与 `Worker.run` 使用同一函数计算 |
| FR-005 | 配置文件只写部分 `worker` 字段时，`envAllow` 保持默认值 |

## 4. 验收

1. 源环境含 `PISA_TELEGRAM_TOKEN=SECRET`、`GH_TOKEN=SECRET` 时，`workerEnv` 输出不含这两个键，`PATH` / `HOME` 保留
2. 真实 `Worker.run` 的子进程输出不含 `SECRET`，且仍有 `PISA_WORKDIR`、`PISA_PROGRESS_FILE`
3. 启动日志列出实际放行的变量名
4. `bun test` 与 `bunx tsc --noEmit` 通过

## 5. 非目标

- 对放行变量的值做脱敏或改写（继承即原值）
- 子进程内部再隔离（网络、文件系统）——不属于本项
- 为不同适配器声明各自的默认白名单：适配器注入的变量本来就独立于白名单
