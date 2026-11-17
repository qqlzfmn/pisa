# 014 · 任务

- [x] `src/git.ts`：`stageAllExcept` 全量暂存后按谓词分拣，命中项 `git reset --`；`commitStaged` 替代 `commitAll`
- [x] `src/deliver.ts`：`isSensitivePath` 规则表；`deliver` 用分拣结果决定提交与推送
- [x] `src/types.ts`：`DeliveryResult.blocked`
- [x] `src/router.ts`：回执追加敏感路径行，日志带 `blocked` 计数
- [x] `tests/deliver.test.ts`：规则表、部分拦截、全拦、`.gitignore` 绕过、改名整条拦截
- [x] `tests/router.test.ts`：回执点名且任务仍成功
- 验证：`bun test`（135 个全绿）、`bunx tsc --noEmit`
