# 002 · 任务拆分（tasks）

- [x] T1 配置：`worker.concurrency`（默认 2）
- [x] T2 存储：`claimQueued()` 原子占位
- [x] T3 调度：`active` 槽位表 + `fill()` 补位，`drainOnce()` 兼容串行测试
- [x] T4 状态命令：`/pisa status`
- [x] T5 测试：并发 2 同时开始、并发 1 串行、状态列表
- [x] T6 文档：spec / plan / README 状态
- [x] T7 真实双任务冒烟：两个 omp 同时跑，分支各自只有自己的文件，main 干净

## 验证命令

```bash
bun test
./node_modules/.bin/tsc --noEmit
```
