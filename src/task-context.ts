import type { Task } from "./types";

export interface ContinueComment {
  /** PR 编号 */
  number: number;
  /** 触发续跑的评论正文，已由调用方裁剪 */
  text: string;
}

/**
 * 续跑任务注入 Worker 的上下文：上一轮请求、结果、分支；
 * PR 评论触发的续跑再补 PR 编号与评论正文。
 */
export function continuationContext(
  parent: Pick<Task, "id" | "prompt" | "summary" | "branch">,
  comment?: ContinueComment,
): string {
  const lines = [
    `任务号：${parent.id}`,
    `上一轮请求：${parent.prompt}`,
    `上一轮结果：${(parent.summary ?? "(无摘要)").slice(0, 1500)}`,
    `上一轮分支：${parent.branch}`,
  ];
  if (comment) lines.push(`PR：#${comment.number}`, `PR 评论：${comment.text.slice(0, 1000)}`);
  return lines.join("\n");
}
