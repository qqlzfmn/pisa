# 012 · 实施计划

## D1 命令清单收敛到 `COMMANDS`

`src/config.ts` 导出 `COMMANDS`（`command` / `alias` / `description` / `menu`）与 `BOT_COMMANDS`。`parseCommand` 用 `Map` 查表，不再手写 8 个 if。

理由：模糊匹配、回复建议、Telegram 菜单三处要用同一份命令名；分散声明必然漂移。

## D2 纯函数 `taskGuard`

输入是触发词之后的正文，返回 `{kind:"suggest",command}` / `{kind:"confirm"}` / `null`。

- 只拦「单个 ASCII 词」：`/^[A-Za-z][A-Za-z0-9_-]*$/`。中文、多词、含标点一律 `null`，走原路径。
- 最近命令按 Levenshtein 距离 ≤ 2 取最小；菜单之外的 `confirm` 不参与建议，避免建议一个没有待确认状态的命令。

纯函数放配置解析层，与 `parseCommand` 同层，便于单测。

## D3 Router 拦截点放在 `handle` 的命令分派之后、建任务之前

`task` 类命令先过 `taskGuard`：

- `suggest`：只回复建议命令，直接 return；不调 `claimEvent`，不落库。
- `confirm`：待确认正文存内存 `Map<chatId:userId, {prompt,repo,at}>`，10 分钟过期；回复确认提示后 return。

`confirm` 命令取走待确认项并把 `cmd` 改写为 `task`，用 `fromConfirm` 跳过一次防护，否则 `"refactor"` 会被再拦一次。

私聊未知 `/xxx`：只做错拼建议，其余保持忽略（原行为）。

## D4 `ChannelAdapter.setCommands` 可选方法

`TelegramChannel` 用 `setMyCommands` 实现；`index.ts` 启动时注册 `BOT_COMMANDS`，失败 `console.warn` 不阻断。CLI 不实现，天然跳过。

`confirm` 不进菜单：它只在提示后使用，列出来会误导。

## 验证

- `tests/router.test.ts`：`stats` 不建任务且建议 status、`refactor` 需确认、确认后任务正文、中文直通、无待确认 confirm、私聊 `/stats`
- 新增 `tests/telegram.test.ts`：`setCommands` 调用 `setMyCommands` 且载荷是菜单命令
- `bun test`、`bunx tsc --noEmit`
