# 013 · 任务

- [x] `src/types.ts`：`EffectKind` / `Effect`、`rewound` 状态与迁移
- [x] `src/store.ts`：`task_effects` 表、`effect` / `effectsOf` / `removeEffect`、`rewound` 纳入终态查询
- [x] `src/github.ts`：`prRepoFromUrl`、`prStatus`、`closePr`
- [x] `src/rewind.ts`：`planRewind` / `formatRewindPlan` / `applyRewind` / `formatRewindResult`、revert 回退
- [x] `src/config.ts`：`rewind` 命令（别名 `撤销`，进菜单，带正文）
- [x] `src/router.ts`：副作用记账（worktree / branch / push / pr / comment / merge）、`handleRewind`、私聊 `/rewind`、帮助文本
- [x] `tests/rewind.test.ts`：预览只读、执行、已合并 revert、部分失败重试、状态未知、共享分支、权限与空任务
- [x] `tests/telegram.test.ts`：菜单命令加入 `rewind`
- [x] `README.md`：命令与撤销说明
- [x] 验证：`bun test`、`bunx tsc --noEmit`
