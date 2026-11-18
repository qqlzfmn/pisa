import { describe, expect, test } from "bun:test";
import { GithubActionsTrigger, type GithubActionsOptions } from "../src/triggers/github";
import type { TriggerRequest } from "../src/triggers/types";
import { GITHUB_SECRET, signGithub } from "./triggers-fixtures";

function githubRequest(
  body: string,
  options: { event?: string; signature?: string; delivery?: string } = {},
): TriggerRequest {
  const headers = new Headers();
  if (options.event) headers.set("x-github-event", options.event);
  headers.set("x-hub-signature-256", options.signature ?? signGithub(body));
  if (options.delivery) headers.set("x-github-delivery", options.delivery);
  return { method: "POST", url: new URL("http://127.0.0.1/triggers/github-actions"), headers, body };
}

function makeAdapter(overrides: Partial<GithubActionsOptions> = {}) {
  return new GithubActionsTrigger({
    secret: GITHUB_SECRET,
    chatId: "chat-1",
    userId: "u1",
    repo: "demo",
    ...overrides,
  });
}

const failedRun = JSON.stringify({
  action: "completed",
  repository: { full_name: "acme/pisa" },
  workflow_run: {
    id: 42,
    name: "CI",
    head_branch: "main",
    run_number: 7,
    run_attempt: 2,
    conclusion: "failure",
    html_url: "https://github.com/acme/pisa/actions/runs/42",
  },
});

describe("GitHub Actions 适配器", () => {
  test("合法签名把失败的运行归一化成任务事件", () => {
    const adapter = makeAdapter();
    const req = githubRequest(failedRun, { event: "workflow_run" });

    expect(adapter.verify(req)).toEqual({ ok: true });
    const outcome = adapter.normalize(req);
    if (outcome.kind !== "event") throw new Error(`期望 event，实际 ${outcome.kind}`);

    expect(outcome.payload.externalId).toBe("acme/pisa:42:2");
    expect(outcome.payload.text).toContain("GitHub Actions 失败：acme/pisa · CI");
    expect(outcome.payload.text).toContain("分支 main");
    expect(outcome.payload.text).toContain("attempt 2");
    expect(outcome.payload.chatId).toBe("chat-1");
    expect(outcome.payload.userId).toBe("u1");
    expect(outcome.payload.repo).toBe("demo");
    expect(adapter.dedupeKey(outcome.payload)).toBe("github-actions:acme/pisa:42:2");
  });

  test("签名错误返回 401，且不解析载荷", () => {
    const adapter = makeAdapter();
    const req = githubRequest(failedRun, { event: "workflow_run", signature: "sha256=deadbeef" });
    expect(adapter.verify(req)).toEqual({ ok: false, status: 401, reason: "签名不匹配" });
  });

  test("缺少签名头与非法 JSON 都被拒绝", () => {
    const adapter = makeAdapter();
    const headers = new Headers({ "x-github-event": "workflow_run" });
    expect(adapter.verify({ method: "POST", url: new URL("http://x/"), headers, body: failedRun })).toEqual({
      ok: false,
      status: 401,
      reason: "缺少 X-Hub-Signature-256",
    });

    const invalid = '{"action":';
    const req = githubRequest(invalid, { event: "workflow_run" });
    expect(adapter.normalize(req)).toEqual({ kind: "reject", status: 400, reason: "载荷不是合法 JSON" });
  });

  test("同一运行的重复投递得到相同去重键，attempt 变化则是新事件", () => {
    const adapter = makeAdapter();
    const first = adapter.normalize(githubRequest(failedRun, { event: "workflow_run" }));
    const second = adapter.normalize(githubRequest(failedRun, { event: "workflow_run", delivery: "d-2" }));
    if (first.kind !== "event" || second.kind !== "event") throw new Error("期望 event");

    expect(adapter.dedupeKey(first.payload)).toBe(adapter.dedupeKey(second.payload));

    const retried = JSON.parse(failedRun) as { workflow_run: { run_attempt: number } };
    retried.workflow_run.run_attempt = 3;
    const next = adapter.normalize(githubRequest(JSON.stringify(retried), { event: "workflow_run" }));
    if (next.kind !== "event") throw new Error("期望 event");
    expect(adapter.dedupeKey(next.payload)).not.toBe(adapter.dedupeKey(first.payload));
  });

  test("成功的运行、未完成动作与白名单外仓库都被忽略", () => {
    const adapter = makeAdapter({ repos: ["acme/pisa"] });

    const success = JSON.parse(failedRun) as { workflow_run: { conclusion: string } };
    success.workflow_run.conclusion = "success";
    expect(adapter.normalize(githubRequest(JSON.stringify(success), { event: "workflow_run" }))).toEqual({
      kind: "ignore",
      reason: "运行结论 success 不是失败",
    });

    const running = JSON.parse(failedRun) as { action: string };
    running.action = "in_progress";
    expect(adapter.normalize(githubRequest(JSON.stringify(running), { event: "workflow_run" }))).toEqual({
      kind: "ignore",
      reason: "运行未完成：in_progress",
    });

    const otherRepo = JSON.parse(failedRun) as { repository: { full_name: string } };
    otherRepo.repository.full_name = "other/repo";
    expect(adapter.normalize(githubRequest(JSON.stringify(otherRepo), { event: "workflow_run" }))).toEqual({
      kind: "ignore",
      reason: "仓库 other/repo 不在白名单",
    });
  });

  test("failedOnly=false 时成功也会建任务；非 workflow_run 事件按 delivery 去重", () => {
    const adapter = makeAdapter({ failedOnly: false, events: ["push"] });
    const push = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "acme/pisa" } });
    const first = adapter.normalize(githubRequest(push, { event: "push", delivery: "delivery-1" }));
    const second = adapter.normalize(githubRequest(push, { event: "push", delivery: "delivery-1" }));
    if (first.kind !== "event" || second.kind !== "event") throw new Error("期望 event");

    expect(first.payload.externalId).toBe("delivery-1");
    expect(first.payload.text).toBe("GitHub Actions push：acme/pisa · refs/heads/main");
    expect(adapter.dedupeKey(first.payload)).toBe(adapter.dedupeKey(second.payload));
  });

  test("未订阅事件直接忽略，缺少事件头返回 400", () => {
    const adapter = makeAdapter();
    expect(adapter.normalize(githubRequest(failedRun, { event: "issues" }))).toEqual({
      kind: "ignore",
      reason: "未订阅事件 issues",
    });

    const event = JSON.parse(failedRun) as { repository: { full_name: string } };
    event.repository.full_name = "acme/pisa";
    expect(adapter.normalize(githubRequest(JSON.stringify(event)))).toEqual({
      kind: "reject",
      status: 400,
      reason: "缺少 X-GitHub-Event",
    });
  });
});
