# 021 · 任务清单

- [x] 配置类型：`capabilities`（全局、按仓库）
- [x] `src/capabilities.ts`：解析、合并、清单、摘要、审计格式化
- [x] 适配器：`PISA_CAPABILITIES` 注入
- [x] `Worker.run`：env 取清单、收集违规、返回审计
- [x] 存储：`audit` 列、`setAudit`、读回
- [x] 路由：审计落库（任务与评审）
- [x] 守卫：`parseCapabilities`、`outsideAllowed`、GUI/域名/追加禁令
- [x] 扩展：GUI 工具拦截、读写根目录、拒绝原因
- [x] CLI：`pisa show` 审计行
- [x] 启动日志：每仓库能力行
- [x] 测试：默认路径与放行路径
- [x] 文档：operations、architecture、示例配置、CHANGELOG
