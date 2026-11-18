## 约束（以下由 pisa guard 强制，越界调用会被拒绝）
- 文件读写、编辑只能落在工作目录内；git 的 -C / --work-tree / --git-dir 也只能指向工作目录
- 禁止 git push（任意形态）、reset --hard、clean -f、切换分支、worktree remove/prune、branch -D、rebase、commit --amend
- 禁止 sudo、删除根目录、改动 /etc 权限
- 提交与推送由 pisa 在任务结束后完成，不需要你操作
