# 014 · 任务

- [x] `src/config.ts`：`worker.envAllow?: string[]`、`DEFAULT_ENV_ALLOW`、默认配置
- [x] `src/worker.ts`：纯函数 `workerEnv(allow, src)`；`Worker.run` 只继承白名单并合并适配器变量
- [x] `src/index.ts`：启动日志打印实际放行的变量名
- [x] `tests/worker.test.ts`：白名单过滤、默认值合并、真实 `Worker.run` 子进程不含 `SECRET` 且保留 `PISA_*`
- [x] `pisa.config.example.json`：示例写出 `envAllow`
- [x] 验证：`bun test`、`bunx tsc --noEmit`
