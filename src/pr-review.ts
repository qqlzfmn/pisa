import type { OpenPr } from "./github";
import { DEFAULT_PROMPTS, promptScope, renderPrompt, type PromptLibrary } from "./prompts";

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

/** 评审提示词：段落与内置文本在 src/prompts.ts，可按 owner/repo 覆盖评审标准 */
export function buildReviewPrompt(
  repo: string,
  pr: OpenPr,
  diff: string,
  prompts: PromptLibrary = DEFAULT_PROMPTS,
): string {
  const patch =
    diff.length > REVIEW_DIFF_MAX
      ? `${diff.slice(0, REVIEW_DIFF_MAX)}\n\n（diff 过长，已截断 ${diff.length - REVIEW_DIFF_MAX} 字符；只评审以上内容）`
      : diff;
  return renderPrompt(
    prompts,
    "review",
    {
      repo,
      number: String(pr.number),
      title: pr.title,
      base: pr.baseRefName,
      head: pr.head,
      headSha: pr.headSha,
      url: pr.url,
      diff: patch || "（空）",
    },
    promptScope(repo),
  );
}
