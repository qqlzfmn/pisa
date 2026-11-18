# 015 · 实施计划

## D1 新增 `src/web.ts`，只做「HTTP 外壳 + 复用 Router」

`createWebApp(deps)` 返回 `(req: Request) => Promise<Response>`，路由与鉴权都在这里；`startWebServer` 用 `Bun.serve` 包一层，固定 `hostname: 127.0.0.1`。

理由：请求处理不碰 socket 就能测（`new Request(...)` 直接喂），路由/鉴权/写操作的测试不需要真实端口。Bun 自带 HTTP 服务，没有新增依赖，符合「单页、无框架」。

## D2 写操作全部转成 `IncomingMessage` 调 `Router.handle`

派活 = `${trigger} <prompt>`，取消/合并 = `${trigger} cancel|merge <id>`。白名单、事件去重、状态机、合并时的临时副本与测试，全部沿用既有实现，web 不复制第二套判定。

代价是回复要落到一个收集器：新增 `ReplyBus`（实现 `ChannelAdapter`），请求期间按 `chatId` 缓存 `router` 的回执，其余 `chatId` 原样转发给真实通道。`index.ts` 把 `ReplyBus` 包在真实通道外面再交给 `Router`，IM 路径行为不变（多一次 map 查找）。

派活后的任务号用 `store.taskByEvent(eventId)` 反查，不解析回执文本。

## D3 `IncomingMessage.admin`：已认证入口的显式标记

web 由 token 直接认证操作者，IM 的「请求者」概念不适用。新增可选字段 `admin?: boolean`，只做两件事：

- 跳过单英文词误触防护（表单提交是明确动作，没有聊天可回 `confirm`）
- 跳过 `cancel` / `merge` / `resume` / `rewind` / `continue` 的原请求者校验

不新增权限模型、不改白名单语义：IM 消息没有这个字段，行为完全不变。

## D4 任务 JSON 与日志尾部复用现有模块

- `status.ts` 新增 `taskJson(t, now)`（CLI 已有同名字段集合，抽出共享并补 `duration`），`cli.ts` 改为引用，删掉本地副本
- 日志尾部读取（`readTail` / `tailLines`）从 `cli.ts` 移到 `log.ts`，web 与 CLI 共用

理由：字段集合与「读大文件尾部」都是已有逻辑，复制会漂移。

## D5 配置与启动

`Config.web?: { enabled, port, tokenEnv, userId, chatId }`，默认值进 `DEFAULT_CONFIG`（`enabled:false`、`port:8787`、`tokenEnv:"PISA_WEB_TOKEN"`、`userId` 取 `PISA_CLI_USER`/`$USER`、`chatId:"web"`）。`merge` 对 `web` 做浅合并，避免只写 `{enabled:true}` 时其它字段丢失。

`package.json` 增加 `"web": "bun run src/index.ts --web"`；`--web` 强制启用并回落到 CLI 通道（没人接聊天时也能起服务）。token 从环境变量读；缺失时生成一次性 token 并打印带 `?token=` 的地址，不落盘。

## D6 鉴权

凭证只有请求头：`Authorization: Bearer` 或 `x-pisa-token`（016 起不使用 `?token=` 做接口凭证，也不再下发 cookie）。`/ui` 是不含数据的静态壳，公开返回；地址里的 `?token=` 只用于让页面把凭证存进 `sessionStorage`。比较用 `crypto.timingSafeEqual`（先比长度）。接口未授权一律 401，没有登录页。

`/ui?token=` 打开后页面把 token 写进 `sessionStorage`，调用接口时放进 `Authorization` 头，并用 `history.replaceState` 去掉地址栏里的 token；刷新后从存储取回，不再需要 URL 参数。

## D7 页面

`src/web-ui.ts` 导出单个 HTML 字符串：内联 CSS + 原生 JS，不打包。渲染全部用 `createElement` + `textContent`，prompt 与日志不经过 `innerHTML`。自动刷新 5s，写操作进行中暂停；详情面板有独立刷新按钮，避免读日志时被覆盖。

## 测试

`tests/web.test.ts`（内存库 + 临时 git 仓库 + 假下游通道）：

- 鉴权：接口无请求头 401；两种请求头放行；query 凭证与 cookie 一律拒绝；`/ui` 与 `/ui?token=` 返回不含 token 的页面且不下发 cookie
- 列表：三组数据、计数、repo 过滤
- 详情：prompt/分支/PR/耗时 + 日志尾部格式化；未知任务 404
- 派活：落库 queued + 返回 taskId；空 prompt 400；单英文词不被拦
- 取消：排队任务变 cancelled；他人任务也能取消（admin）
- 合并：缺 `confirm` 400；带 `confirm` 合入主分支并记 `merge` 副作用

验证命令：`bun test`、`bunx tsc --noEmit`；再起一次真实服务用 curl 走 401 → 200 → 派活 → 详情。
