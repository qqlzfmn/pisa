# 014 · 实施计划

## D1 占位顺序：先鉴权与校验，后占位（FR-001）

`Router.handle` 里调整为 `checkAccess` → 仓库存在 → prompt 非空 → `store.claimEvent` → `insertTask`。

理由：占位是幂等语义，只有「会变成任务」的投递才有资格占键。把占位移到校验之后，被拒的投递不再污染共享去重表；重复投递仍在建任务前被挡下。

## D2 webhook 处理逻辑抽到 `src/webhook.ts`（FR-002、FR-003、FR-004）

`index.ts` 里的内联 `fetch` 拆成 `webhookHandler(deps)`，返回 `(req: Request) => Promise<Response>`。依赖只有 `token`、`chatId`、`userId`、`handle`、`now`，用真实 `Request` 对象即可单测，不需要起服务。

- 顺序：方法 → 鉴权 → 体积 → JSON → 字段校验 → 投递。鉴权先于读 body，未授权请求不消耗内存。
- `eventId` 若给出必须 `startsWith("webhook:")`，否则 400；省略时 `webhook:<now>:<random>`。
- 外部 JSON 用运行时校验解析成明确类型，不使用断言。
- token 比较：`Buffer.from` 后先比长度，再 `timingSafeEqual`；长度不等直接 403。
- 体积：先看 `Content-Length`，再对实际读取的 `ArrayBuffer` 字节数做兜底，覆盖没有该头或分块传输的情况。上限 64 KiB。

## D3 文档（FR-005）

README 的 curl 示例改成 `"eventId":"webhook:ci:12345"` 并注明前缀规则；`docs/specs/003-super-agent-loop/spec.md` §3.3 的示例同步。

## 验证

- `tests/webhook.test.ts`：前缀 400 且不投递、省略时生成 `webhook:` 前缀、等长与不等长错误 token 403、超限 413
- `tests/router.test.ts`：被拒投递不占用 `eventId`、同 `eventId` 重复投递只建一个任务
- `bun test`、`bunx tsc --noEmit`
