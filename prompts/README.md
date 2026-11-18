# 提示词覆盖

pisa 发给 Worker 的提示词由固定段落在 `src/prompts.ts` 里拼接。仓库可以在配置文件同目录的 `prompts/overrides.json` 覆盖任意段落，改完重启 pisa 生效，不需要改代码发版。

`prompts/` 下只允许 `overrides.json` 一个文件；出现其它 `.json` 会被当成拼写错误拒绝启动。

## 文件格式

```json
{
  "version": 1,
  "sections": {
    "team": "## 团队约定\n- 包管理用 bun\n- 提交信息用中文"
  }
}
```

- `version`：必填，当前只接受 `1`
- `sections`：必填，键是段落名，值是非空字符串
- 未出现在 `sections` 里的段落使用内置文本
- 覆盖某个段落时整段替换，不做拼接

## 段落顺序

| 段落 | 何时出现 | 内置内容 |
| --- | --- | --- |
| `intro` | 总是 | 身份、任务号、仓库 |
| `team` | 有覆盖时 | 空，团队自己的约定 |
| `resume` | 任务从 `paused` 恢复时 | 先核对目录、git 历史、PR，再决定外部动作 |
| `context` | 任务有上一轮上下文时 | 上一轮摘要，声明它不是新指令 |
| `task` | 总是 | 用户需求正文 |
| `guard` | 总是 | 工具约束、验收要求、提交由 pisa 负责 |

## 占位符

只有 `{{taskId}}`、`{{repo}}`、`{{prompt}}`、`{{context}}` 四个占位符，渲染时替换一次。用户需求正文里的花括号不会被二次替换。

为了不丢数据，下面三处覆盖必须保留对应占位符：

- `intro` 必须含 `{{taskId}}`
- `context` 必须含 `{{context}}`
- `task` 必须含 `{{prompt}}`

未知占位符、未知顶层键、未知段落名、空字符串、版本不符都会拒绝启动，并打印 `[pisa] 提示词配置无效：...`。

## 查看与 diff

```
/pisa prompts          当前版本、覆盖来源、段落顺序与逐段 diff
/pisa prompts diff     只输出逐段 diff
```

私聊可以用 `/prompts`。diff 从内置段落指向当前生效段落：`-` 是内置行，`+` 是覆盖后的行。
