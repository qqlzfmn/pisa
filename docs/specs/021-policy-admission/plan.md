# 021 · 实施计划

## 1. 结构

```
src/policy.ts           策略解析、内容哈希版本、判定、恢复重校验、展示（纯函数）
src/config.ts           Config.policy；COMMANDS 增加 policy/策略
src/types.ts            IncomingMessage.mentioned、Mandate、Task.mandate
src/store.ts            tasks.mandate 列（含旧库迁移）、admissions 表与读写
src/router.ts           准入前置校验、observe 记录、/pisa policy、resume 重校验
src/retention.ts        admissions 随事件一起按保留期清理
src/channels/telegram.ts  entities → mentioned
src/triggers/feishu.ts    mentions → mentioned
src/status.ts           TaskJson.mandate
```

判定只发生在 `Router.handle` 一处：所有入口（通道、适配器、定时、主动发现、web）最终都投递 `IncomingMessage` 给 `Router.handle`，策略按 `msg.channel` 取规则。

## 2. 关键取舍

| 决策 | 备选 | 理由 |
| --- | --- | --- |
| 版本 = 策略表内容哈希（12 位） | 配置里手写 `policy.version` | 手写版本要靠人维护，忘了改就永远「没变」；内容哈希天然只在规则实际变化时变，且不需要第二份真相 |
| 规则按 `channel` 取，不看 `eventId` 前缀 | 按事件前缀（`webhook:`、`cron:`）分类 | `channel` 本来就是入口标识，由各适配器自己填；前缀是字符串约定，改一处就错 |
| 真实发起人只在「该来源配置了策略」时生效 | 一律按 `actor` 判定 | 现有 GitHub/飞书/企业微信的 `userId` 是投递身份；若默认按 `actor`，`whitelist.users` 里的配置身份瞬间全部失效（回归）；配置策略即视为运营方明确接管该入口 |
| `allowed` 缺省取该入口自身 `users` 白名单 | 强制重写 `allowed` | 飞书/企业微信用 `openId`、`userId` 是投递身份，和全局 `whitelist.users` 不同源；缺省绑定到同一入口已有白名单避免配错 |
| 未配置来源的 `accept` 缺省 `auto` | 缺省 `observe` | 019 的非目标就是「不改变既有入口」；默认收紧会让升级即停派活 |
| observe 只记录 `admissions`、不回派 | 也建任务再标 quarantined | 未接单就是未接单；建任务会占 worktree、跑 Worker，与「观察」语义矛盾 |
| `admissions` 随 `purgeEvents` 同一保留期清理 | 永久保留 | 记录只用于策略调参，保留期之外没有用途；复用 retention 避免再加开关 |
| 恢复按 `mandate` 重放，不重建消息 | 恢复时重新解析原消息 | 原消息不入库；`mandate` 已保存判定所需的三个事实（来源、主体、是否 @） |
| 任务没有 `mandate`（旧库）时按 `channel` + `requester` 回落 | 直接拒绝旧任务恢复 | 旧任务接单时没有策略，按当时规则（默认 `auto`）等价处理，避免升级即卡死所有历史任务 |

## 3. 配置

```jsonc
"policy": {
  "sources": {
    "telegram": { "accept": "auto" },
    "feishu":   { "accept": "observe",
                  "cells": { "unlisted": { "mention": "deny", "plain": "deny" } } },
    "github":   { "accept": "auto", "allowed": ["alice", "bob"] },
    "webhook":  { "accept": "auto" },
    "cron":     { "accept": "off" }
  }
}
```

`cells` 缺省：`listed.{mention,plain}=allow`，`unlisted.*=deny`。`allowed` 缺省 `whitelist.users`（飞书/企业微信取各自 `triggers.<name>.users`）。

## 4. 失败语义

- 拒绝文案保留「无权限」前缀（既有调用方与测试依赖），追加策略版本。
- 拒绝回复对同一用户 24h 内只发一次（沿用 `deniedAt`），避免群内陌生人刷屏。
- `observe` 回执只在首次记录时发送（`INSERT OR IGNORE` 返回是否新插入），重投不重复打扰。
- 恢复被拒不动任务状态，`paused` 保持，可改配置后再次尝试。

## 5. 验证

- `tests/policy.test.ts`：四格矩阵、`off`/`observe`、版本变化、actor 来源、`recheck` 降权与恢复、`formatPolicy` 含版本。
- `tests/router.test.ts`：越权拒绝不占 eventId、observe 只记录、`mandate` 落库、`/pisa policy` 输出、resume 在策略收紧后被拒且保持 paused、默认策略下既有 resume 通过。
