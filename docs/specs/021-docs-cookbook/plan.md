# 021 · 实现计划

## 结构

```
docs/
  domain.md        术语表：定义 + 边界 + 代码位置
  deployment.md    安装 / 升级 / 常驻 / 端口与数据 / 退出码 / 排障
  extending.md     加 Source（TriggerAdapter）/ 加 Adapter（WorkerAdapter）
  architecture.md  索引表新增两行指向新文档
tests/
  docs-cookbook.test.ts  文档存在性、互链、路径存在、退出码与代码一致
```

## 决定与理由

| 决定 | 理由 |
| --- | --- |
| 三份文档独立，不合并进 `operations.md` | `operations.md` 是「已经跑起来之后怎么用」；装、升级、排障、扩展面向不同时刻的读者，合并会让单文件继续膨胀 |
| 术语表按「定义 → 边界 → 代码」三段写 | 只写定义无法消除歧义（例如 status 与 stage、撤销与回滚）；代码位置让读者能跳到事实源 |
| 部署文档按「装 → 跑 → 升级 → 常驻 → 排障」排列 | 与读者真实顺序一致；排障表按症状索引，而不是按模块 |
| 扩展指南以接口成员为准，逐步写「实现 → 装配 → 配置 → 测试」 | `architecture.md` 只给接口契约；缺的是装配点与测试样板，这两处最容易漏 |
| 测试只校验可机检的事实：路径存在、互链、退出码与 `helpText()` 一致 | 文档语义无法自动验证；但这三类漂移最常见，且能在 CI 里拦住 |
| 退出码事实源取 `helpText()` 而非 `EXIT` 常量 | `EXIT` 未导出；`helpText()` 是用户实际看到的文本，文档与它必须一致（FR-005） |

## 互链

- `docs/architecture.md`：开头「规格细节」段与文末索引入口。
- `README.md`、`CONTRIBUTING.md`：文档地图各加三行。
- `docs/operations.md`：安装、升级、常驻、排障处改为指向 `deployment.md`，避免两处维护命令。

## 验证

- `bun test tests/docs-cookbook.test.ts`
- `bun test`（全量，含 `docs-links` 与 `architecture-doc`）
- `bunx tsc --noEmit`
