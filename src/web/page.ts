import { formatDuration } from "../format";
import { rateLine, stackedBars } from "./chart";
import type { WebState } from "./view";

const STATUS_LABEL: Record<string, string> = {
  queued: "排队",
  running: "运行中",
  paused: "暂停",
  succeeded: "成功",
  failed: "失败",
  cancelled: "取消",
  rewound: "已撤销",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function repoRow(repo: { alias?: string; path?: string; remote?: string; baseBranch?: string }): string {
  return `<div class="row repo-row">
  <input class="alias" placeholder="别名" value="${esc(repo.alias ?? "")}">
  <input class="path" placeholder="/绝对/路径" value="${esc(repo.path ?? "")}">
  <input class="remote" placeholder="远程（可选）" value="${esc(repo.remote ?? "")}">
  <input class="base" placeholder="主干 main" value="${esc(repo.baseBranch ?? "")}">
  <button type="button" class="del" title="删除">×</button>
</div>`;
}

function scheduleRow(job: { id?: string; cron?: string; prompt?: string; repo?: string; enabled?: boolean }): string {
  return `<div class="row job-row">
  <input class="id" placeholder="id" value="${esc(job.id ?? "")}">
  <input class="cron" placeholder="0 9 * * 1-5" value="${esc(job.cron ?? "")}">
  <input class="repo" list="repo-aliases" placeholder="仓库别名（可选）" value="${esc(job.repo ?? "")}">
  <label class="chk"><input type="checkbox" class="enabled" ${job.enabled === false ? "" : "checked"}>启用</label>
  <button type="button" class="del" title="删除">×</button>
  <textarea class="prompt" rows="2" placeholder="到点后发给 worker 的需求">${esc(job.prompt ?? "")}</textarea>
</div>`;
}

function taskRows(state: WebState): string {
  if (state.tasks.length === 0) return `<tr><td colspan="7" class="empty">还没有任务</td></tr>`;
  return state.tasks
    .map(
      (t) => `<tr>
  <td class="mono">${esc(t.id)}</td>
  <td><span class="badge ${esc(t.status)}">${esc(STATUS_LABEL[t.status] ?? t.status)}</span></td>
  <td>${esc(t.repo)}</td>
  <td class="prompt">${esc(t.prompt)}</td>
  <td class="mono">${formatDuration(t.durationMs)}</td>
  <td>${t.prUrl ? `<a href="${esc(t.prUrl)}" target="_blank" rel="noreferrer">PR</a>` : ""}</td>
  <td>${t.canRewind ? `<button type="button" class="rewind" data-id="${esc(t.id)}">撤销</button>` : ""}</td>
</tr>`,
    )
    .join("");
}

function auditRows(state: WebState): string {
  if (state.audit.length === 0) return `<tr><td colspan="5" class="empty">没有写操作</td></tr>`;
  return state.audit
    .map(
      (a) => `<tr>
  <td class="mono">${esc(new Date(a.at).toLocaleString("zh-CN", { hour12: false }))}</td>
  <td class="mono">${esc(a.action)}</td>
  <td class="mono">${esc(a.target)}</td>
  <td>${a.ok ? "✓" : "✗"}</td>
  <td class="prompt">${esc((a.detail ?? "").slice(0, 160))}</td>
</tr>`,
    )
    .join("");
}

function totals(state: WebState): string {
  const items: Array<[string, number]> = [
    ["总数", state.totals.total],
    ["运行中", state.totals.running],
    ["排队", state.totals.queued],
    ["暂停", state.totals.paused],
    ["成功", state.totals.succeeded],
    ["失败", state.totals.failed],
  ];
  return items.map(([label, n]) => `<div class="stat"><span class="n">${n}</span><span>${label}</span></div>`).join("");
}

export function renderPage(state: WebState): string {
  const rate = rateLine(state.daily.map((d) => ({ label: d.date.slice(5), value: d.successRate })));
  const duration = stackedBars(
    state.daily.map((d) => ({
      label: d.date.slice(5),
      parts: [{ value: Math.round((d.avgDurationMs ?? 0) / 1000), color: "#0ea5e9" }],
    })),
  );
  const queue = stackedBars(
    state.queue.map((q) => ({
      label: q.label,
      parts: [
        { value: q.running, color: "#16a34a" },
        { value: q.queued, color: "#f59e0b" },
      ],
    })),
  );
  const config = state.config;
  const issues = state.configIssues.length
    ? `<div class="banner bad">当前配置文件未通过校验，表单展示运行时生效的配置：<ul>${state.configIssues
        .map((e) => `<li>${esc(e)}</li>`)
        .join("")}</ul></div>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pisa 控制台</title>
<style>
  :root { color-scheme: light; --line: #d8dee6; --muted: #667085; --bad: #b42318; --ok: #067647; }
  * { box-sizing: border-box; }
  body { margin: 0 auto; max-width: 1080px; padding: 24px 20px 64px; font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", sans-serif; color: #101828; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 32px 0 8px; }
  .hint, .muted { color: var(--muted); font-size: 12px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
  .stat { border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; min-width: 84px; display: flex; flex-direction: column; }
  .stat .n { font-size: 20px; font-weight: 600; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .card h3 { font-size: 13px; margin: 0 0 4px; font-weight: 600; }
  svg { width: 100%; height: auto; display: block; }
  .axis { stroke: #cbd5e1; stroke-width: 1; }
  .tick { fill: var(--muted); font-size: 9px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: 12px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .prompt { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
  .empty { color: var(--muted); text-align: center; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 11px; background: #eef2f6; }
  .badge.running { background: #dcfae6; color: var(--ok); }
  .badge.failed { background: #fee4e2; color: var(--bad); }
  .badge.succeeded { background: #e0f2fe; }
  .badge.rewound { background: #f4f3ff; }
  button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: #fff; cursor: pointer; }
  button:hover { background: #f8fafc; }
  button.primary { background: #111827; color: #fff; border-color: #111827; }
  .row { display: grid; grid-template-columns: 1fr 2fr 1fr 1fr auto; gap: 6px; margin-bottom: 6px; }
  .job-row { grid-template-columns: 1fr 1fr 1fr auto auto; align-items: start; }
  .job-row .prompt { grid-column: 1 / -1; max-width: none; }
  .chk { display: flex; align-items: center; gap: 4px; font-size: 12px; white-space: nowrap; }
  input, textarea { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; width: 100%; }
  fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 0 0 12px; padding: 12px; }
  legend { font-size: 12px; color: var(--muted); padding: 0 6px; }
  .banner { margin: 12px 0; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); }
  .banner.bad { border-color: #fda29b; background: #fffbfa; color: var(--bad); }
  .banner.good { border-color: #abefc6; background: #f6fef9; color: var(--ok); }
  .banner ul { margin: 6px 0 0; padding-left: 18px; }
  pre { white-space: pre-wrap; background: #f8fafc; border: 1px solid var(--line); border-radius: 6px; padding: 10px; font-size: 12px; }
  #rewind[hidden] { display: none; }
  dialog { border: 1px solid var(--line); border-radius: 10px; max-width: 640px; width: calc(100% - 32px); padding: 16px; }
  dialog::backdrop { background: rgba(16, 24, 40, .35); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
</head>
<body>
<header>
  <h1>pisa 控制台</h1>
  <p class="hint">只监听 127.0.0.1 · 页面生成于 ${esc(new Date(state.now).toLocaleString("zh-CN", { hour12: false }))}</p>
</header>

<div class="stats">${totals(state)}</div>
${issues}

<div class="charts">
  <div class="card"><h3>成功率（近 7 天，按完成日）</h3>${rate}</div>
  <div class="card"><h3>平均耗时（近 7 天，秒）</h3>${duration}</div>
  <div class="card"><h3>队列深度（近 24 小时）</h3>${queue}
    <p class="hint"><span class="badge running">运行中</span> <span class="badge">排队</span> 采样点为每个整点</p>
  </div>
</div>

<h2>任务</h2>
<table>
  <thead><tr><th>任务号</th><th>状态</th><th>仓库</th><th>需求</th><th>耗时</th><th>PR</th><th></th></tr></thead>
  <tbody>${taskRows(state)}</tbody>
</table>

<section id="rewind" class="card" hidden>
  <h3>撤销预览</h3>
  <pre id="rewind-text"></pre>
</section>

<h2>配置</h2>
<form id="config">
  <fieldset>
    <legend>仓库</legend>
    <div id="repos">${config.repos.map(repoRow).join("")}</div>
    <button type="button" class="add" data-target="repos">添加仓库</button>
  </fieldset>
  <fieldset>
    <legend>Worker</legend>
    <div class="row">
      <label>adapter<input class="w-adapter" value="${esc(config.worker.adapter)}"></label>
      <label>command<input class="w-command" value="${esc(config.worker.command)}"></label>
      <label>timeoutSec<input class="w-timeout" type="number" min="1" max="86400" value="${config.worker.timeoutSec}"></label>
      <label>concurrency<input class="w-concurrency" type="number" min="1" max="64" value="${config.worker.concurrency}"></label>
      <label>extraArgs<input class="w-extra" placeholder="逗号分隔" value="${esc(config.worker.extraArgs.join(", "))}"></label>
    </div>
  </fieldset>
  <fieldset>
    <legend>调度身份</legend>
    <div class="row">
      <label>chatId<input class="s-chat" value="${esc(config.scheduler.chatId)}"></label>
      <label>userId<input class="s-user" value="${esc(config.scheduler.userId)}"></label>
    </div>
    <p class="hint">定时任务到点后以这个身份投递；不配置调度身份时无法保存定时任务。</p>
  </fieldset>
  <fieldset>
    <legend>定时任务</legend>
    <div id="jobs">${config.schedules.map(scheduleRow).join("")}</div>
    <button type="button" class="add" data-target="jobs">添加定时任务</button>
  </fieldset>
  <datalist id="repo-aliases">${config.repos.map((r) => `<option value="${esc(r.alias)}"></option>`).join("")}</datalist>
  <div id="config-errors"></div>
  <button type="submit" class="primary">保存配置</button>
  <span class="hint">保存后需重启 pisa 生效</span>
</form>

<h2>审计</h2>
<table>
  <thead><tr><th>时间</th><th>动作</th><th>目标</th><th>结果</th><th>详情</th></tr></thead>
  <tbody>${auditRows(state)}</tbody>
</table>

<dialog id="ask">
  <form method="dialog">
    <h3 id="ask-title"></h3>
    <pre id="ask-body"></pre>
    <div class="actions">
      <button value="no">取消</button>
      <button value="yes" class="primary">确认</button>
    </div>
  </form>
</dialog>

<template id="repo-template">${repoRow({})}</template>
<template id="job-template">${scheduleRow({})}</template>

<script>
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  function banner(text, kind) {
    let el = $("#flash");
    if (!el) {
      el = document.createElement("div");
      el.id = "flash";
      $("header").after(el);
    }
    el.className = "banner " + (kind === "bad" ? "bad" : "good");
    el.textContent = text;
    el.scrollIntoView({ block: "nearest" });
  }

  function ask(title, body) {
    const dlg = $("#ask");
    $("#ask-title").textContent = title;
    $("#ask-body").textContent = body;
    dlg.returnValue = "no";
    dlg.showModal();
    const { promise, resolve } = Promise.withResolvers();
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "yes"), { once: true });
    return promise;
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { data = { ok: false, error: "响应不是 JSON" }; }
    return { status: res.status, ...data };
  }

  function stripEmpty(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== "" && v !== undefined));
  }

  function readRepos() {
    return [...document.querySelectorAll(".repo-row")].map((row) =>
      stripEmpty({
        alias: $(".alias", row).value.trim(),
        path: $(".path", row).value.trim(),
        remote: $(".remote", row).value.trim(),
        baseBranch: $(".base", row).value.trim(),
      }),
    );
  }

  function readJobs() {
    return [...document.querySelectorAll(".job-row")].map((row) =>
      stripEmpty({
        id: $(".id", row).value.trim(),
        cron: $(".cron", row).value.trim(),
        prompt: $(".prompt", row).value.trim(),
        repo: $(".repo", row).value.trim(),
        enabled: $(".enabled", row).checked,
      }),
    );
  }

  function readPatch() {
    const extra = $(".w-extra").value.split(",").map((s) => s.trim()).filter(Boolean);
    return {
      repos: readRepos(),
      worker: {
        adapter: $(".w-adapter").value.trim(),
        command: $(".w-command").value.trim(),
        timeoutSec: Number($(".w-timeout").value),
        concurrency: Number($(".w-concurrency").value),
        extraArgs: extra,
      },
      scheduler: {
        chatId: $(".s-chat").value.trim(),
        userId: $(".s-user").value.trim(),
      },
      schedules: readJobs(),
    };
  }

  document.querySelectorAll(".add").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      const tpl = target === "repos" ? $("#repo-template") : $("#job-template");
      $(target === "repos" ? "#repos" : "#jobs").appendChild(tpl.content.cloneNode(true));
    });
  });

  document.addEventListener("click", (e) => {
    const del = e.target.closest && e.target.closest(".del");
    if (del) del.closest(".row").remove();
  });

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest && e.target.closest(".rewind");
    if (!btn) return;
    const id = btn.dataset.id;
    const preview = await post("/api/rewind/preview", { taskId: id });
    if (!preview.ok) return banner(preview.error || "预览失败", "bad");
    const panel = $("#rewind");
    panel.hidden = false;
    $("#rewind-text").textContent = preview.text;
    panel.scrollIntoView({ block: "nearest" });
    if (!(await ask("执行撤销 " + id + "？", preview.text))) return;
    const out = await post("/api/rewind/apply", { taskId: id, token: preview.token });
    $("#rewind-text").textContent = out.text || out.error || "";
    banner(out.ok ? "撤销完成，页面即将刷新" : "撤销未全部成功：" + (out.error || ""), out.ok ? "good" : "bad");
    if (out.ok) setTimeout(() => location.reload(), 1500);
  });

  $("#config").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errors = $("#config-errors");
    errors.innerHTML = "";
    const patch = readPatch();
    const check = await post("/api/config", { patch, dryRun: true });
    if (!check.ok) {
      errors.innerHTML = '<div class="banner bad"><ul>' +
        (check.errors || [check.error || "校验失败"]).map((m) => "<li>" + m.replace(/[<>&]/g, "") + "</li>").join("") +
        "</ul></div>";
      return;
    }
    if (!(await ask("保存配置？", "将写入服务器上的配置文件：\\n" + JSON.stringify(patch, null, 2)))) return;
    const saved = await post("/api/config", { patch, token: check.token });
    if (!saved.ok) {
      errors.innerHTML = '<div class="banner bad">' + (saved.error || (saved.errors || []).join("；")) + "</div>";
      return;
    }
    banner("已保存，重启 pisa 后生效", "good");
    setTimeout(() => location.reload(), 1500);
  });
})();
</script>
</body>
</html>`;
}
