# brief 模板

brief 是 Worker 唯一的需求来源。它看不到你的会话历史，也不会追问。按下面的结构写，能显著减少"改错地方"和"猜需求"。

## 模板

```text
目标：<一句话说明完成后系统应有的行为>
现状：<你观察到的现象、报错、失败命令与关键输出>
证据：<文件路径:行号、日志片段、测试名、复现步骤>
范围：
- 只改 <目录/文件/模块>
- 不要动 <明确排除的部分>
验收：
- <可执行的验证命令与期望结果>
- <需要新增/更新的测试>
约束：<兼容性、性能、依赖、风格要求；没有就写"无">
```

## 好的 brief 示例

### 修 CI

```text
目标：让 `bun test` 在 main 上恢复绿色。
现状：CI 在 tests/router.test.ts 的 "continue 继承分支" 用例失败，报
`expect(received).toBe(expected)`，received 为 undefined。
证据：tests/router.test.ts:212；CI 日志 ci-run-8891；本地 `bun test tests/router.test.ts` 可复现。
范围：
- 只改 src/router.ts 与对应测试
- 不要动 GitHub 投递逻辑
验收：
- `bun test tests/router.test.ts` 通过
- `bun test` 全量通过
- 不改变现有续跑语义（新任务 baseRef 仍等于父任务 branch）
约束：无新依赖。
```

### PR 评论迭代

```text
目标：处理 PR #42 的三条 review 评论。
现状：评论要求：1) 错误信息改成中文；2) 补空输入测试；3) 去掉未使用的 helper。
证据：PR #42 评论正文（见下）；相关文件 src/validate.ts:18-40、tests/validate.test.ts。
范围：只改 src/validate.ts、tests/validate.test.ts。
验收：
- 错误信息为中文且测试断言对应文案
- 新增空字符串与 null 两个用例
- `bun test tests/validate.test.ts` 通过
约束：保持导出函数签名不变。
```

### Issue → PR

```text
目标：实现 issue #17：CLI 支持 `--dry-run`，只打印将执行的动作，不写库。
现状：当前 `pisa run` 无条件入队；issue 要求 dry-run 输出任务 JSON 但不创建任务。
证据：issue #17；src/cli.ts 的 task 分支；tests/cli.test.ts 现有提交用例。
范围：
- 只改 src/cli.ts、tests/cli.test.ts、skills/pisa/references/commands.md
- 不改任务状态机与数据库 schema
验收：
- `pisa run "x" --dry-run --json` 输出将创建的任务字段，退出码 0
- 执行后 `pisa list` 数量不变
- 新增测试覆盖 dry-run 不入队
- `bun test` 与 `bunx tsc --noEmit` 通过
约束：不新增依赖。
```

## 反例

| 写法 | 问题 |
| --- | --- |
| `修一下登录` | 没有现象、文件、验收，Worker 只能猜 |
| `把代码优化一下` | 无边界，容易大改 |
| `按上次说的改` | Worker 没有会话记忆 |
| `跑测试，失败就修` | 可以，但应附上失败命令与当前输出，减少重复探索 |
| 粘贴整份 10MB 日志 | 噪声；只给失败前后 50 行与关键堆栈 |

## 写 brief 的检查清单

- [ ] 目标能用一句话说清"完成后什么行为变了"
- [ ] 至少一条可执行验证命令
- [ ] 明确"不要改什么"
- [ ] 文件路径带行号或符号名
- [ ] 没有密钥、token、个人隐私
- [ ] 没有要求 Worker 执行 `git commit` / `push` / 开 PR（交付阶段负责）
- [ ] 长 brief 用 `pisa run "$(cat brief.txt)"` 或 heredoc 传入，避免 shell 转义问题
