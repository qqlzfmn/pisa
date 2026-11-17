# 003 · 任务拆分

- [x] T1 pi 扩展：session_start / tool_call / tool_result / agent_end
- [x] T2 策略拦截：破坏性命令返回 `{ block: true }`
- [x] T3 进度文件 + Router 轮询与节流转发
- [x] T4 会话 id 落库（`session_id`）
- [x] T5 续跑命令（`continue`）与会话恢复
- [x] T6 webhook 事件入口
- [x] T7 看护脚本 `scripts/supervise.sh`
- [x] T8 测试：19 个用例通过
- [x] T9 真实 omp 验证：进度上报、会话 id、continue 分支续跑
- [x] T10 自举：merge 验证 + 合入主干 + 看护进程重启（已实测）
