# 019 · 方案

## 分工

| 位置 | 职责 | 不做什么 |
| --- | --- | --- |
| `src/ops.ts` | 健康判定（唯一实现）、去重记录读写、告警文本 | 不启动进程、不发消息、不写业务状态 |
| `src/cli.ts` | `status` 输出与退出码、`patrol` 子命令、Telegram 投递 | 不复制判定条件 |
| `src/config.ts` | `patrol.chatId` | — |
| `scripts/patrol.sh` / `scripts/install-launchd.sh` | 每小时触发与环境变量加载 | 不解析输出 |

## 判定顺序

`opsHealth()` 按「配置 → 部件 → 进程」收集问题，再按 `config > component > restart > ok` 取最高级：

- 配置缺失时先修配置，否则重启也会立刻再挂
- 部件坏了时重启无效，必须先修部件
- 只有前面都正常，才把心跳缺失归因为「需重启」

问题 key 是稳定标识（不含时间与心跳时长），因此去重与恢复判定不会被文案变化影响。心跳问题只在 `daemon:heartbeat` 上，`message` 里可以带「最后心跳 3m 前」。

## 去重

`patrolTick()` 读取 `meta['patrol:alerted']` 的 key 集合：

1. 当前问题集合与旧集合求差，得到 fresh
2. fresh 为空 → 只把当前集合写回（问题恢复时自然清除），不输出、不发送
3. fresh 非空 → 先发送/输出完整问题列表，成功后再写去重记录；发送抛错则不写，下一小时重试

按 key 而不是整体指纹去重：`A+B` 变成 `A` 不重复提醒，`B` 再次出现时算新问题。

## 投递

`pisa patrol` 是一次性 CLI 进程，不依赖守护进程：

- 配置了 `patrol.chatId` 且 `channels.telegram.tokenEnv` 有值 → 新建 `TelegramChannel` 发送后退出
- 否则只写 stdout；`scripts/patrol.sh` 由 launchd 启动时 stdout 落到 `~/Library/Logs/pisa.patrol.log`
- Telegram 投递失败只写 stderr，退出码仍是健康码（巡检本身成功，交付失败下轮重试）

## 与 `/health` 的关系

`/health` 只回答「HTTP 服务与调度是否活着」，`ok` 只看心跳；运维码覆盖配置与部件，范围更大。两者都读同一份 `daemonState()`，不重复实现心跳判断。

## 风险

- `pisa status` 从永远 0 变成可能非 0：用 `set -e` 的脚本会被影响，属于本次要修的契约；文档与 skill 同步更新。
- 巡检依赖外部 launchd 才能做到「每小时」：进程内自巡检无法发现自身死亡，因此选择独立进程 + 落库去重。
- `patrol.chatId` 是新增配置；不配置时行为仍然完整（stdout），不会静默丢告警。
