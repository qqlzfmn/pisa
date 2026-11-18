# 022 实现计划

## 决策

1. **按读者拆三页，不扩写 architecture。** `architecture.md` 回答「为什么这样分层」，已经 37 KB；把术语、命令、步骤塞进去只会让它更难读。新页面各自只回答一个问题：这个词是什么、怎么把它跑起来、怎么接一个新的。
2. **`domain.md` 只做索引。** 每个术语给一句定义、一个代码落点；行为细节留在 `architecture.md` 与代码，避免出现第二套真相源。
3. **`deployment.md` 接手机器生命周期，`operations.md` 保留配置与功能手册。** 常驻与退出码从 `operations.md` 迁走，原位置只留一行链接；安装步骤与 README 首页不重复，指回 README。
4. **`extending.md` 以「身份」开头。** 新来源最容易错的是 `threadKey` / `messageKey` / `version` / `actor`，先定这四个，再谈解析与鉴权。
5. **测试守结构，不守措辞。** 断言文档存在、互链成立、术语覆盖、代码路径存在、退出码与常量一致、bash 块语法通过、`bun run` 目标存在；不比较段落文字，避免正常编辑就红。
6. **不加占位命令。** 文档里的 `bash` 块都能在仓库根执行，或明确是待替换的配置值；测试用 `bash -n` 拒绝语法错误。

## 备选与取舍

| 方案 | 取舍 |
| --- | --- |
| 只扩写 `architecture.md` | 拒绝：设计文档会被操作步骤淹没，且无法承担排障表的更新频率 |
| 新建 `docs/cookbook.md` 单页 | 拒绝：三类读者与更新触发点不同，单页会重新长成第二个 operations |
| 把常驻细节同时留在两处 | 拒绝：违反单一真相源，升级时容易只改一边 |
| 文档测试只查文件存在 | 拒绝：链接、退出码与命令仍会腐烂，至少守住可机器验证的部分 |

## 实施步骤

1. 写 `spec.md`，记录缺口证据与 FR。
2. 写 `domain.md`、`deployment.md`、`extending.md`。
3. 改 `architecture.md` 索引与 §4 链接；README/CONTRIBUTING 文档地图加入三页。
4. 从 `operations.md` 移除常驻与退出码重复段，改成指向 `deployment.md` 的链接。
5. 新增 `tests/docs-cookbook.test.ts`，覆盖 FR-001 至 FR-007 中可机器验证的部分。
6. 跑定向测试、全量 `bun test`、`bunx tsc --noEmit`。

## 验证

| 步骤 | 检查 |
| --- | --- |
| 文档结构 | `bun test tests/docs-cookbook.test.ts` |
| 链接与既有架构表 | `bun test tests/docs-links.test.ts tests/architecture-doc.test.ts` |
| 全量回归 | `bun test` |
| 类型 | `bunx tsc --noEmit` |
| 人工 | 从 `architecture.md` 点进三页，再点回；复制部署命令到空目录执行 `bash -n` |
