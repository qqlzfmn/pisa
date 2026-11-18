import type { OpenPr } from "./github";

/** diff 超过该长度截断：任务正文要进 SQLite，也要进 Worker 上下文 */
export const REVIEW_DIFF_MAX = 60_000;

/** 评审线程按 PR 归并；同一 PR 的不同 head 是同一线程的新版本 */
export function reviewThreadKey(repo: string, pr: number): string {
  return `github:${repo}:pull:${pr}:review`;
}

/** 事件键带 head SHA：同一版本只投递一次 */
export function reviewEventId(repo: string, pr: number, headSha: string): string {
  return `github:review:${repo}:${pr}:${headSha}`;
}

export function buildReviewPrompt(repo: string, pr: OpenPr, diff: string): string {
  const patch =
    diff.length > REVIEW_DIFF_MAX
      ? `${diff.slice(0, REVIEW_DIFF_MAX)}\n\n（diff 过长，已截断 ${diff.length - REVIEW_DIFF_MAX} 字符；只评审以上内容）`
      : diff;
  return [
    `评审 PR ${repo}#${pr.number}：${pr.title}`,
    "",
    `- 基线：${pr.baseRefName} ← ${pr.head} @ ${pr.headSha}`,
    `- 链接：${pr.url}`,
    "",
    "## 要求",
    "- 这是只读评审：不要修改代码，不要创建或切换分支，不要提交、推送或创建 PR。",
    "- 当前工作目录是空的临时目录，没有检出仓库；只依据下面的 diff 评审，不要尝试运行测试。",
    "- 从正确性、回归风险、测试覆盖、可维护性、安全五个方面评审；只指出有证据的问题。",
    "- 结论第一行给判定：通过 / 有建议 / 需要修改；再按文件列问题（位置、原因、建议）。",
    "- 不要复述 diff；没有发现问题就明确说明。",
    "",
    "## Diff",
    "```diff",
    patch || "（空）",
    "```",
  ].join("\n");
}
