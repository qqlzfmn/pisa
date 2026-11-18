# 022 · 方案

## 数据结构

```jsonc
{
  "policy": {
    "sources": {
      "github": {
        "allowed": ["alice", "bob"],
        "accept": "auto",
        "admit": {
          "listed":   { "mentioned": "allow", "unmentioned": "deny" },
          "unlisted": { "mentioned": "deny",  "unmentioned": "deny" }
        }
      },
      "feishu": { "accept": "observe" }
    }
  }
}
```

- 判定输入只有三个值：来源（`msg.channel`）、真实 actor（`msg.actor ?? msg.userId`）、是否 @（`msg.mentioned ?? (isDirect || 正文以触发词开头)`）。
- 解析后的 `Policy` 与版本在 Router 构造时算一次；改配置要重启，重启后新版本自然生效。
- mandate 与版本分两列：mandate 回答「当时怎么判的」，`policy_version` 回答「按哪版规则」，两者都挂在任务行上，恢复时分别用来重放输入与展示差异。

## 版本

`canonical({ whitelist, sources })`：对象键排序、数组自身排序去重后做 sha256，取前 8 位。把 `whitelist` 纳入是因为 `checkAccess` 也是准入的一部分，删人必须换版本；把解析后的策略而不是原始 JSON 纳入，是因为等价写法不该产生版本漂移。

## 落点

| 位置 | 改动 |
| --- | --- |
| `src/config.ts` | `PolicyConfig`/`PolicySourceConfig`/`AdmissionTableConfig`、`Config.policy`、`policy` 命令进 `COMMANDS` |
| `src/policy.ts` | 来源清单、默认准入表、`resolvePolicy`、`decide`、`formatPolicy` |
| `src/router.ts` | 构造时解析策略；建任务前判准入；任务写 mandate/版本；resume 前重判 + `checkAccess`；`/pisa policy` 分支 |
| `src/store.ts` | `tasks.mandate`/`tasks.policy_version` 列与迁移；`countActiveByPolicyVersion` |
| `src/types.ts` | `IncomingMessage.mentioned`、`TaskMandate`、`Task.mandate`/`Task.policyVersion` |
| `src/triggers/feishu.ts` | 归一化时给出 `mentioned`（占位符或 p2p） |

## 取舍

- **判定放在 Router 而不是各适配器**：来源、actor、@ 都已经在 `IncomingMessage` 上，适配器再判一遍会分叉；`observe` 需要照建任务并记录判定，只有 core 能做到。
- **默认表拒绝「名单内未 @」**：这是本次唯一的行为变化，针对群里没打招呼的闲聊；私聊与带触发词的消息按定义已 @，不受影响。企业微信私聊、文件监听、cron、探针都走 `isDirect`，行为不变。
- **`allowed` 留空=不限制**：与 `whitelist.users` 留空的既有语义一致；要收紧必须显式列名单，`unlisted` 两格才有意义。
- **恢复时重跑 `checkAccess`**：策略版本覆盖 `whitelist`，但仓库白名单、仓库目录是否还是 git 仓库无法从 mandate 推出，必须重查；两者都失败时先报策略原因。
- **`off`/`observe`/`auto`**：`off` 用于临时关某个入口而不删配置；`observe` 用于先观察会拦下谁，mandate 里的 `reason` 是审计依据。
