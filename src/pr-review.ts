import type { OpenPr } from "./github";

/** 注入提示词的 diff 上限：超出时截断并明确告知评审者 */
export const MAX_REVIEW_DIFF_CHARS = 40_000;

export interface ReviewPromptInput {
  repo: string;
  pr: OpenPr;
  diff: string;
}

/** 评审任务的需求正文：只读约束、PR 元信息与 diff */
export function buildReviewPrompt({ repo, pr, diff }: ReviewPromptInput): string {
  const raw = diff.trim();
  const truncated = raw.length > MAX_REVIEW_DIFF_CHARS;
  const shown = truncated ? raw.slice(0, MAX_REVIEW_DIFF_CHARS) : raw;
  return [
    `你是代码评审者。评审仓库 ${repo} 的 PR #${pr.number}，head SHA 为 ${pr.headSha}。`,
    ``,
    `## 只读约束`,
    `- 这是只读评审：不要修改工作目录内任何文件，不要创建提交，不要推送，不要创建或更新 PR。`,
    `- 不要自己发评论；pisa 会把你的结论回帖到 PR。`,
    `- 可以运行只读命令查看仓库现状，但不要执行会改变仓库或远端状态的命令。`,
    ``,
    `## 评审重点`,
    `正确性、边界条件、错误处理、可维护性、测试覆盖。只评论这次 diff 引入或暴露的问题，不要求重写无关代码。`,
    ``,
    `## 输出`,
    `用中文先给结论：通过 / 需要修改。再列必改项（文件与行号）和建议；没有问题时说明检查过哪些方面。不要寒暄。`,
    ``,
    `## PR 标题`,
    pr.title.trim() || "(无标题)",
    ``,
    `## PR 描述`,
    pr.body.trim() || "(无描述)",
    ``,
    `## 变更 diff${truncated ? `（超过 ${MAX_REVIEW_DIFF_CHARS} 字，已截断）` : ""}`,
    shown || "(无 diff)",
  ].join("\n");
}
