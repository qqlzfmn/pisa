import { COMMANDS, type HelpGroup } from "./config";

/** 帮助与示例的唯一文案来源：命令是否存在归 config，怎么讲归这里 */

export interface ExampleScenario {
  /** 场景名 */
  title: string;
  /** 可直接照抄的触发方式，`{trigger}` 替换成配置的触发词 */
  trigger: string;
  /** 预期产出 */
  outcome: string;
}

export const EXAMPLES: readonly ExampleScenario[] = [
  {
    title: "单个需求",
    trigger: "{trigger} 修复登录超时，补一条回归测试",
    outcome: "回执 → 独立工作副本 → pisa/<任务号> 分支 → 进度回传 → 摘要与 PR/对比链接；主干不动",
  },
  {
    title: "指定仓库",
    trigger: "{trigger} @family 把首页文案改成中文",
    outcome: "同一条链路，落在 family 仓库；回执写明「仓库：family」，其它仓库不受影响",
  },
  {
    title: "接着上一轮做",
    trigger: "{trigger} continue t_xxx 错误提示改成中文（或直接回复任务消息）",
    outcome: "复用原分支追加提交，上下文带上上一轮的摘要与分支名",
  },
  {
    title: "看板与取消",
    trigger: "{trigger} status，然后 {trigger} cancel t_xxx",
    outcome: "三段看板（运行中/排队/最近完成）；取消在 2 秒轮询内生效，任务收口为「取消」",
  },
  {
    title: "撤销副作用",
    trigger: "{trigger} rewind t_xxx 预览，确认后加 --yes",
    outcome: "关闭 PR、删本地与远程分支、移除工作副本；已合并的任务用 revert 提交回退，不改写历史",
  },
  {
    title: "自举合并",
    trigger: "{trigger} merge t_xxx",
    outcome: "临时副本跑 bun test，通过后 --ff-only 合入主干；看护模式下进程被拉起并加载新代码",
  },
  {
    title: "CI 失败投递",
    trigger: 'curl -X POST http://127.0.0.1:8799/event -H "x-pisa-token: $PISA_WEBHOOK_TOKEN" -H "Content-Type: application/json" -d \'{"prompt":"跑测试并修掉失败","eventId":"webhook:ci:12345"}\'',
    outcome: "与 IM 相同的排队、执行、回执链路；同一 eventId 只建一个任务",
  },
  {
    title: "PR 评论派活",
    trigger: "在 PR 评论里写 {trigger} 把这里的错误处理补上",
    outcome: "在该 PR 的分支继续提交并更新原 PR，不新开分支；摘要回帖到仓库",
  },
];

const GROUP_ORDER: readonly HelpGroup[] = ["派活", "查询", "维护", "集成"];

/** 派活组里不占命令名的入口：裸需求与仓库前缀 */
const TASK_ENTRIES: ReadonlyArray<{ usage: string; description: string }> = [
  { usage: "<需求>", description: "接一个任务" },
  { usage: "@别名 <需求>", description: "指定仓库（多仓库时用）" },
];

/** 集成组没有斜杠命令：入口来自 webhook、评论轮询与定时器 */
const INTEGRATION_ENTRIES: ReadonlyArray<{ usage: string; description: string }> = [
  { usage: "webhook POST /event", description: "CI/监控投递任务，头 x-pisa-token，可带 repo 别名" },
  { usage: "PR/Issue 评论 {trigger} <需求>", description: "评论里派活；PR 上已有任务则接续原分支" },
  { usage: "定时触发", description: "schedules 到点自动开单，查看用 schedules 命令" },
];

function entryLine(usage: string, description: string): string {
  return `  ${usage} · ${description}`;
}

/** 把 `{trigger}` 换成配置的触发词 */
function fill(text: string, trigger: string): string {
  return text.split("{trigger}").join(trigger);
}

export function formatHelp(trigger: string): string {
  const lines = [
    "pisa · 命令（完整场景与边界：docs/usage.md）",
    "私聊可直接说需求（不用触发词）；/help、/status、/cancel、/examples 等命令也可省略触发词。",
  ];
  for (const group of GROUP_ORDER) {
    lines.push("", group);
    if (group === "派活") for (const t of TASK_ENTRIES) lines.push(entryLine(`${trigger} ${t.usage}`, t.description));
    for (const c of COMMANDS) {
      if (c.group !== group) continue;
      const args = c.args ? ` ${c.args}` : "";
      lines.push(entryLine(`${trigger} ${c.command}${args}`, c.description));
    }
    if (group === "集成") for (const e of INTEGRATION_ENTRIES) lines.push(entryLine(fill(e.usage, trigger), e.description));
  }
  return lines.join("\n");
}

export function formatExamples(trigger: string): string {
  const blocks = EXAMPLES.map(
    (e, i) => `${i + 1}. ${e.title}\n   触发：${fill(e.trigger, trigger)}\n   产出：${fill(e.outcome, trigger)}`,
  );
  return ["pisa · 可直接照抄的场景（说明与边界见 docs/usage.md）", "", ...blocks].join("\n");
}
