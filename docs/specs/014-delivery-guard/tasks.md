# 014 · 任务

- [x] `src/git.ts`：`stageAllExcept` 全量暂存后按谓词分拣，命中项 `git reset --`；读索引/读分支范围共用 `nameStatus`，显式 `-M` 强制改名探测，失败向上抛；`branchEntries` 读 `base...HEAD`；`commitStaged` 替代 `commitAll`，提交与推送加 `--no-verify`
- [x] `src/deliver.ts`：`isSensitivePath` 规则表；`deliver` 用分拣结果决定提交，推送前核对整条分支历史
- [x] `src/types.ts`：`DeliveryResult.blocked`
- [x] `src/router.ts`：回执追加敏感路径行，日志带 `blocked` 计数
- [x] `tests/deliver.test.ts`：规则表、部分拦截、全拦、`.gitignore` 绕过、改名整条拦截、关掉 `diff.renames` 的改名绕过、hook 注入、agent 自己提交后不推送
- [x] `tests/router.test.ts`：回执点名且任务仍成功
- 验证：`bun test`（138 个全绿）、`bunx tsc --noEmit`
