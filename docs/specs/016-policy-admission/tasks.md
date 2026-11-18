# tasks

- [x] `src/policy.ts`：准入纯函数（`admit`/`resolvePolicy`/`sanitizePolicy`/`policyVersion`/`mandateOf`/`formatPolicy`）与默认表，`Record` 静态表 + 深合并两层
- [x] `src/types.ts`：`IncomingMessage.mentioned`、`Task.mandate`、`Task.policyVersion`
- [x] `src/store.ts`：`tasks` 新增 `mandate`/`policy_version` 列与迁移，读回解析失败降级为 `null`
- [x] `src/config.ts`：`policy` 配置项、配置告警、`policy` 命令（别名 `策略`，菜单可见）
- [x] `src/router.ts`：`claimEvent` 后按来源准入，拒单与观察共用节流；`checkAccess` 收窄为 `checkRepo`；任务写入 mandate 与版本；`/pisa policy`；`handleResume` 恢复前重校验
- [x] `src/cli.ts`：`pisa task`/`continue` 走同一准入判定，拒单以用法错误退出；`pisa show` 展示准入凭据
- [x] `src/status.ts`：`TaskJson` 暴露 `mandate`/`policyVersion`
- [x] `src/proactive.ts`：关键词开单标记 `mentioned: false`
- [x] `tests/policy.test.ts`：默认表、部分覆盖、拒单原因、观察模式、配置告警、版本稳定性与 `formatPolicy`
- [x] `tests/router.test.ts`：凭据与版本落库、点名放宽、未点名判定、`allowed=false`/`off` 拒单、观察不建任务、策略变更不追溯、降权后恢复被拒、`/pisa policy` 可见性
- [x] `tests/cli.test.ts`：CLI 建单记录凭据、拒单退出码 2
- [x] `tests/proactive.test.ts`：关键词开单记为未点名
- [x] 文档：README「准入策略」、`docs/usage.md` 鉴权面、`docs/architecture.md` 模块表与准入/恢复流程
