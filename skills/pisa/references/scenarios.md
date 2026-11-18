# 三个可复制场景

以下命令只依赖 `pisa`、`git`、`gh` 与 POSIX shell，不依赖任何专有工具。假设已能运行 `pisa help`。

变量先设好：

```bash
REPO=demo                 # pisa 仓库别名
GH_REPO=owner/repo        # GitHub 仓库，Issue/PR 用
```

JSON 解析示例用 `jq`；没有 `jq` 时把 `--json` 输出交给你的 agent 直接读取。

---

## 场景 1：修 CI

**触发**：CI 失败，需要定位并修到全绿。

```bash
# 1. 确认守护进程与仓库
pisa status --json | jq '.daemon'
pisa repos --json | jq '.[] | select(.alias=="'"$REPO"'")'

# 2. 收集失败证据（替换成你的 CI 命令）
bun test 2>&1 | tail -60
git log --oneline -5

# 3. 提交，event-id 用 CI run 号保证重试幂等（CI_RUN_ID 由 CI 注入，重试保持不变）
pisa run "$(cat <<'EOF'
目标：让 `bun test` 恢复全绿。
现状：tests/router.test.ts 的 "continue 继承分支" 用例失败，received 为 undefined。
证据：tests/router.test.ts:212；本地 `bun test tests/router.test.ts` 可复现。
范围：只改 src/router.ts 与对应测试；不动 GitHub 投递与状态机。
验收：
- `bun test tests/router.test.ts` 通过
- `bun test` 全量通过
- 续跑语义不变（新任务 baseRef 等于父任务 branch）
约束：无新依赖。
EOF
)" --repo "$REPO" --event-id "ci:${CI_RUN_ID}" --json
```

**轮询**：

```bash
ID=t_20261118_ab12cd     # 上一步返回的 id
pisa wait "$ID" --timeout 1200 --json
```

- 退出码 0：读 `summary`，再自己跑一遍 `bun test` 验收。
- 退出码 2 且 `status: failed`：`pisa logs "$ID" --tail 200`，按 [failures.md](failures.md) 判断。
- 退出码 2 且 `timeout: true`：`pisa show "$ID" --json`，仍在 running 就继续等，不要重提。

**补一轮修改**：

```bash
pisa continue "$ID" "测试仍有一个断言用旧文案，改成新文案并跑 bun test tests/router.test.ts" --wait --timeout 900 --json
```

---

## 场景 2：PR 评论迭代

**触发**：PR 有新 review 评论，需要按评论改。

```bash
PR=42
pisa status --json | jq '.daemon.alive'

# 1. 读评论（只取未处理的，人工确认范围）
gh pr view "$PR" --repo "$GH_REPO" --json reviews,comments \
  --jq '.reviews[].body, .comments[].body'

# 2. 找回这个 PR 上已有的 pisa 任务：优先在最近成功的任务上续跑
pisa list --pr "$PR" --github-repo "$GH_REPO" --json \
  | jq '[.[] | select(.status=="succeeded")][0]'

# 3. 续跑（ID 用上一步的 id；REVIEW_ID 用评论批次标识，重试保持不变）
PARENT=t_20261118_ab12cd
pisa continue "$PARENT" "$(cat <<'EOF'
按 PR #42 的 review 评论修改：
1) 错误信息改成中文；
2) 补空字符串与 null 两个测试；
3) 删除未使用的 helper。
验收：bun test tests/validate.test.ts 通过；导出函数签名不变。
EOF
)" --event-id "pr-$PR-review-${REVIEW_ID}" --wait --timeout 1200 --json
```

**结果检查**：

```bash
pisa show "$PARENT" --json | jq '{id,status,branch,prUrl,summary,error}'
```

- 新任务会落在父任务分支与同一 `prUrl`；有推送权限时 PR 自动更新。
- 若 `list --pr` 为空：该 PR 不是 pisa 建的，先新建任务并把 PR 内容写进 brief；不要让续跑去猜分支。
- 若退出码 2 且父任务 paused/cancelled：交给人处理，或 `pisa retry` 重排一次。

**回写评论**（需人类同意后再执行）：

```bash
gh pr comment "$PR" --repo "$GH_REPO" --body "已处理 1-3，验证：bun test tests/validate.test.ts 通过。"
```

---

## 场景 3：Issue → PR

**触发**：把 issue 实现成 PR。

```bash
ISSUE=17
pisa status --json | jq '.daemon.alive'

# 1. 读 issue
gh issue view "$ISSUE" --repo "$GH_REPO" --json title,body,labels \
  --jq '{title,body,labels:[.labels[].name]}'

# 2. 提交实现任务
pisa run "$(cat <<'EOF'
目标：实现 issue #17：CLI 增加 `--dry-run`，只输出将创建的任务，不写库。
现状：当前 `pisa run` 无条件入队；issue 要求 dry-run 返回任务 JSON 但不创建任务。
证据：issue #17；src/cli.ts 的 task 分支；tests/cli.test.ts 现有提交用例。
范围：只改 src/cli.ts、tests/cli.test.ts、skills/pisa/references/commands.md；不改状态机与 schema。
验收：
- `pisa run "x" --dry-run --json` 输出将创建的任务字段，退出码 0
- 执行后 `pisa list --json` 数量不变
- 新增测试覆盖 dry-run 不入队
- `bun test` 与 `bunx tsc --noEmit` 通过
约束：不新增依赖。
EOF
)" --repo "$REPO" --event-id "issue:$ISSUE" --json

# 3. 等待并取 PR
ID=t_20261118_ab12cd
pisa wait "$ID" --timeout 1800 --json | jq '{status,branch,prUrl,summary,error}'
```

**验收**：

```bash
pisa show "$ID" --json | jq -r '.prUrl'    # 有 PR 时打开核对
git log --oneline -1 "$(pisa show "$ID" --json | jq -r '.branch')"
```

- `prUrl` 为 null：检查 `delivery.push` / `delivery.pr` 与仓库 remote 是否为 GitHub。
- 需要把 PR 链接写回 issue 时，先得到人类同意，再 `gh issue comment "$ISSUE" --repo "$GH_REPO" --body "PR: <url>"`。
- 需求变更：`pisa continue "$ID" "<新要求>"`，不要新开任务重复实现。

---

## 三个场景的共同检查

```bash
pisa status --json | jq '{daemon:.daemon.alive, running:(.running|length), queued:(.queued|length)}'
```

- 提交前：`daemon.alive=true`、仓库 `allowed=true`
- 提交后：保存返回的 `id`；重试必须复用 `--event-id`
- 结束时：核对 `status`、`summary`、`branch`、`prUrl`，再决定是否继续或汇报
