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
export function continuationContext(parent: Task, comment?: ContinueComment): string {
  const lines = [
    `任务号：${parent.id}`,
    `上一轮请求：${parent.prompt}`,
    `上一轮结果：${(parent.summary ?? "(无摘要)").slice(0, 1500)}`,
    `上一轮分支：${parent.branch}`,
  ];
  if (comment) lines.push(`PR：#${comment.number}`, `PR 评论：${comment.text.slice(0, 1000)}`);
  return lines.join("\n");
}

/**
 * 重试上下文：同一需求再跑一遍，不复用上一轮的分支与 PR。
 * 前一轮的失败原因要带给 Worker，否则它会以为是首次执行。
 */
export function retryContext(parent: Task): string {
  const lines = [continuationContext(parent), `本轮是任务 ${parent.id} 的重试，上一轮状态：${parent.status}。`];
  if (parent.error) lines.push(`上一轮错误：${parent.error.slice(0, 1500)}`);
  return lines.join("\n");
}
