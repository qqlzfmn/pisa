/**
 * 控制台单页：内联样式与原生脚本，不打包、不引框架。
 * 所有数据渲染都走 createElement + textContent，prompt 与日志不经过 innerHTML。
 */
export const WEB_UI = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pisa 控制台</title>
<style>
  :root { color-scheme: light dark; --line: #d0d7de; --muted: #6a737d; --accent: #1f6feb; --bad: #cf222e; --ok: #1a7f37; --bg: #f6f8fa; }
  @media (prefers-color-scheme: dark) { :root { --line: #30363d; --muted: #8b949e; --accent: #58a6ff; --bad: #ff7b72; --ok: #3fb950; --bg: #161b22; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 2; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0; }
  h2 { font-size: 14px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
  h3 { font-size: 13px; margin: 14px 0 6px; }
  main { padding: 16px; display: grid; gap: 16px; max-width: 1400px; }
  section { border: 1px solid var(--line); border-radius: 6px; padding: 12px; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 12px; }
  .badge { font-size: 12px; font-weight: normal; color: var(--muted); }
  .bad { color: var(--bad); }
  .ok { color: var(--ok); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; white-space: nowrap; }
  td.prompt { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.num { white-space: nowrap; }
  button, select, textarea, input { font: inherit; color: inherit; }
  button { border: 1px solid var(--line); background: transparent; border-radius: 6px; padding: 3px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger:hover { border-color: var(--bad); color: var(--bad); }
  button:disabled { opacity: .45; cursor: default; border-color: var(--line); color: inherit; }
  button.link { border: 0; padding: 0; color: var(--accent); }
  textarea { width: 100%; min-height: 68px; resize: vertical; border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: transparent; }
  input { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; background: transparent; }
  input[type=checkbox] { width: auto; }
  td textarea { min-height: 40px; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 12px; }
  .form-grid label { display: grid; gap: 2px; font-size: 12px; color: var(--muted); }
  pre { margin: 0; padding: 8px; border: 1px solid var(--line); border-radius: 6px; overflow: auto; max-height: 360px; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0 0 12px; font-size: 13px; }
  dt { color: var(--muted); }
  dd { margin: 0; word-break: break-all; }
  #detail { border-color: var(--accent); }
  .charts { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .chart { border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
  .chart h3 { margin: 0 0 4px; }
  .legend { display: flex; gap: 10px; font-size: 11px; color: var(--muted); margin-bottom: 6px; }
  .chip::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 4px; border-radius: 2px; background: var(--accent); vertical-align: middle; }
  .bars { display: flex; align-items: flex-end; gap: 1px; height: 72px; border-bottom: 1px solid var(--line); }
  .bar-col { flex: 1; display: flex; align-items: flex-end; gap: 1px; height: 100%; }
  .bar { flex: 1; background: var(--accent); }
  .bar.p95 { background: #8250df; }
  .bar.queue { background: #bf8700; }
  .bar.running, .bar.rate { background: var(--ok); }
  .chip.p95::before { background: #8250df; }
  .chip.queue::before { background: #bf8700; }
  .chip.running::before, .chip.rate::before { background: var(--ok); }
  .axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 2px; }
  #toast { position: fixed; right: 16px; bottom: 16px; max-width: 420px; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); box-shadow: 0 4px 16px rgba(0,0,0,.15); font-size: 13px; white-space: pre-wrap; }
</style>
</head>
<body>
<header>
  <h1>pisa 控制台</h1>
  <span id="daemon" class="muted">连接中…</span>
  <div class="spacer"></div>
  <label class="muted">仓库 <select id="repo"><option value="">全部</option></select></label>
  <button id="refresh">刷新</button>
</header>
<main>
  <section>
    <h2>派活</h2>
    <textarea id="prompt" placeholder="描述要做的事；Enter 提交，Shift+Enter 换行"></textarea>
    <div class="row">
      <span id="dispatch-msg" class="muted"></span>
      <div class="spacer"></div>
      <button id="send" class="primary">派活</button>
    </div>
  </section>

  <section>
    <h2>趋势 <span id="metrics-range" class="badge"></span></h2>
    <div class="charts" id="charts"></div>
  </section>

  <section>
    <h2>运行中 <span id="count-running" class="badge"></span></h2>
    <table><thead><tr><th>任务号</th><th>仓库</th><th>状态</th><th>阶段</th><th>耗时</th><th>内容</th><th>分支</th><th>PR</th></tr></thead><tbody id="rows-running"></tbody></table>
  </section>

  <section>
    <h2>排队 <span id="count-queued" class="badge"></span></h2>
    <table><thead><tr><th>任务号</th><th>仓库</th><th>状态</th><th>阶段</th><th>耗时</th><th>内容</th><th>分支</th><th>PR</th></tr></thead><tbody id="rows-queued"></tbody></table>
  </section>

  <section>
    <h2>最近完成 <span id="count-finished" class="badge"></span></h2>
    <table><thead><tr><th>任务号</th><th>仓库</th><th>状态</th><th>阶段</th><th>耗时</th><th>内容</th><th>分支</th><th>PR</th></tr></thead><tbody id="rows-finished"></tbody></table>
  </section>

  <section id="detail" hidden></section>

  <section>
    <h2>配置 <span id="config-path" class="muted"></span></h2>
    <div class="muted" id="config-note"></div>
    <h3>仓库</h3>
    <table><thead><tr><th>别名</th><th>路径</th><th>主干</th><th>remote</th><th></th></tr></thead><tbody id="config-repos"></tbody></table>
    <h3>Worker</h3>
    <div class="form-grid">
      <label>adapter<input id="worker-adapter"></label>
      <label>command<input id="worker-command"></label>
      <label>并发<input id="worker-concurrency" type="number" min="1" max="64"></label>
      <label>超时（秒）<input id="worker-timeout" type="number" min="1"></label>
    </div>
    <div class="muted" id="worker-extra"></div>
    <h3>定时任务</h3>
    <table><thead><tr><th>id</th><th>cron</th><th>仓库</th><th>内容</th><th>启用</th><th></th></tr></thead><tbody id="config-schedules"></tbody></table>
    <div class="row">
      <button id="add-repo">添加仓库</button>
      <button id="add-schedule">添加定时任务</button>
      <div class="spacer"></div>
      <button id="load-config">重新读取</button>
      <button id="save-config" class="primary">保存配置</button>
    </div>
    <div id="config-errors" class="bad"></div>
  </section>

  <section>
    <h2>审计 <span id="audit-path" class="muted"></span></h2>
    <table><thead><tr><th>时间</th><th>动作</th><th>对象</th><th>结果</th><th>详情</th></tr></thead><tbody id="rows-audit"></tbody></table>
  </section>
</main>
<div id="toast" hidden></div>

<script>
(function () {
  'use strict';
  var state = { repo: '', busy: false, detail: null };
  var config = { repos: [], schedules: [] };
  var token = new URLSearchParams(location.search).get('token');
  if (token) history.replaceState(null, '', location.pathname);

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function withToken(path) {
    if (!token) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
  }
  function toast(text, bad) {
    var box = document.getElementById('toast');
    box.textContent = text || '';
    box.className = bad ? 'bad' : '';
    box.hidden = !text;
    if (text) setTimeout(function () { box.hidden = true; }, 6000);
  }
  function showAuth() {
    document.getElementById('daemon').textContent = '未授权：请用启动日志里 /ui?token=... 的地址打开';
    document.getElementById('daemon').className = 'bad';
  }
  async function api(path, init) {
    var opts = Object.assign({ credentials: 'same-origin', headers: {} }, init || {});
    if (opts.body) opts.headers['content-type'] = 'application/json';
    var res = await fetch(withToken(path), opts);
    if (res.status === 401) { showAuth(); throw new Error('未授权'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || data.ok === false) {
      var err = new Error(data.message || data.error || ('HTTP ' + res.status));
      err.data = data;
      throw err;
    }
    return data;
  }
  function cell(row, child, cls) {
    var td = el('td', cls);
    td.appendChild(child);
    row.appendChild(td);
  }
  function inputEl(value, placeholder, type) {
    var input = el('input');
    input.type = type || 'text';
    input.value = value === undefined || value === null ? '' : String(value);
    if (placeholder) input.placeholder = placeholder;
    return input;
  }
  function taskRow(task, index) {
    var row = el('tr');
    var idBtn = el('button', 'link', task.id);
    idBtn.title = '查看详情';
    idBtn.addEventListener('click', function () { openDetail(task.id); });
    cell(row, idBtn, 'num');
    cell(row, el('span', null, task.repo));
    cell(row, el('span', task.status === 'failed' ? 'bad' : (task.status === 'succeeded' ? 'ok' : null), task.statusLabel));
    cell(row, el('span', null, task.stage + '（' + task.stageLabel + '）'), 'num');
    cell(row, el('span', null, task.duration), 'num');
    var prompt = el('div', 'prompt', task.prompt);
    prompt.title = task.prompt;
    cell(row, prompt, 'prompt');
    cell(row, el('span', null, task.branch || '-'));
    if (task.prUrl) {
      var link = el('a', null, 'PR');
      link.href = task.prUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      cell(row, link);
    } else {
      cell(row, el('span', 'muted', '-'));
    }
    return row;
  }
  function fillRows(id, tasks) {
    var body = document.getElementById(id);
    body.textContent = '';
    if (!tasks.length) {
      var row = el('tr');
      var td = el('td', 'muted', '（空）');
      td.colSpan = 8;
      row.appendChild(td);
      body.appendChild(row);
      return;
    }
    tasks.forEach(function (task, index) { body.appendChild(taskRow(task, index)); });
  }
  function renderBoard(data) {
    var daemon = document.getElementById('daemon');
    daemon.className = data.daemon.alive ? 'muted' : 'muted bad';
    daemon.textContent = '守护进程' + (data.daemon.alive ? '在线' : '离线') +
      '（心跳 ' + (data.daemon.ageMs === null ? '无记录' : Math.round(data.daemon.ageMs / 1000) + 's 前') + '）' +
      ' · 运行 ' + data.counts.running + ' / 排队 ' + data.counts.queued + ' / 中断 ' + data.counts.paused;
    var select = document.getElementById('repo');
    if (select.options.length <= 1 && data.repos.length) {
      data.repos.forEach(function (alias) {
        var option = el('option', null, alias);
        option.value = alias;
        select.appendChild(option);
      });
      select.value = state.repo;
    }
    document.getElementById('count-running').textContent = data.running.length + ' 条';
    document.getElementById('count-queued').textContent = data.queued.length + ' 条';
    document.getElementById('count-finished').textContent = data.finished.length + ' 条（最多 20）';
    fillRows('rows-running', data.running);
    fillRows('rows-queued', data.queued);
    fillRows('rows-finished', data.finished);
  }
  async function loadBoard() {
    try {
      var query = state.repo ? '?repo=' + encodeURIComponent(state.repo) : '';
      renderBoard(await api('/api/tasks' + query));
    } catch (err) {
      document.getElementById('daemon').textContent = '加载失败：' + err.message;
      document.getElementById('daemon').className = 'bad';
    }
  }
  function fmtMs(ms) {
    if (ms === null || ms === undefined) return '-';
    return ms >= 60000 ? (ms / 60000).toFixed(1) + ' 分' : Math.round(ms / 1000) + ' 秒';
  }
  function fmtRate(rate) {
    return rate === null || rate === undefined ? '-' : Math.round(rate * 100) + '%';
  }
  function hourLabel(ts) {
    var d = new Date(ts);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':00';
  }
  function chartBlock(title, buckets, series, fixedMax) {
    var block = el('div', 'chart');
    block.appendChild(el('h3', null, title));
    var legend = el('div', 'legend');
    series.forEach(function (s) { legend.appendChild(el('span', 'chip ' + s.cls, s.label)); });
    block.appendChild(legend);
    var max = fixedMax || 0;
    buckets.forEach(function (b) {
      series.forEach(function (s) {
        var v = s.value(b);
        if (typeof v === 'number' && v > max) max = v;
      });
    });
    var bars = el('div', 'bars');
    buckets.forEach(function (b) {
      var col = el('div', 'bar-col');
      col.title = [hourLabel(b.start)].concat(series.map(function (s) { return s.label + ' ' + s.text(b); })).join('\\n');
      series.forEach(function (s) {
        var v = s.value(b);
        var bar = el('div', 'bar ' + s.cls);
        var ratio = max > 0 && typeof v === 'number' ? v / max : 0;
        bar.style.height = Math.round(ratio * 100) + '%';
        col.appendChild(bar);
      });
      bars.appendChild(col);
    });
    block.appendChild(bars);
    var axis = el('div', 'axis');
    if (buckets.length) {
      axis.appendChild(el('span', null, hourLabel(buckets[0].start)));
      axis.appendChild(el('span', null, hourLabel(buckets[Math.floor(buckets.length / 2)].start)));
      axis.appendChild(el('span', null, hourLabel(buckets[buckets.length - 1].start)));
    }
    block.appendChild(axis);
    return block;
  }
  function renderMetrics(data) {
    var summary = data.summary;
    document.getElementById('metrics-range').textContent = data.hours + ' 小时 · 完成 ' + summary.finished +
      ' · 成功率 ' + fmtRate(summary.successRate) + ' · P50 ' + fmtMs(summary.p50Ms) + ' · P95 ' + fmtMs(summary.p95Ms);
    var box = document.getElementById('charts');
    box.textContent = '';
    var buckets = data.buckets || [];
    box.appendChild(chartBlock('成功率', buckets, [{
      label: '成功率', cls: 'rate',
      value: function (b) { return b.successRate; },
      text: function (b) { return fmtRate(b.successRate) + '（完成 ' + b.finished + '）'; }
    }], 1));
    box.appendChild(chartBlock('耗时', buckets, [
      { label: 'P50', cls: 'p50', value: function (b) { return b.p50Ms; }, text: function (b) { return fmtMs(b.p50Ms); } },
      { label: 'P95', cls: 'p95', value: function (b) { return b.p95Ms; }, text: function (b) { return fmtMs(b.p95Ms); } }
    ]));
    box.appendChild(chartBlock('队列', buckets, [
      { label: '排队', cls: 'queue', value: function (b) { return b.queueDepth; }, text: function (b) { return String(b.queueDepth); } },
      { label: '运行', cls: 'running', value: function (b) { return b.running; }, text: function (b) { return String(b.running); } }
    ]));
  }
  async function loadMetrics() {
    try {
      renderMetrics(await api('/api/metrics?hours=24'));
    } catch (err) {
      toast('指标加载失败：' + err.message, true);
    }
  }
  function renderRepoRows() {
    var body = document.getElementById('config-repos');
    body.textContent = '';
    if (!config.repos.length) {
      var empty = el('tr');
      var td = el('td', 'muted', '（未配置仓库）');
      td.colSpan = 5;
      empty.appendChild(td);
      body.appendChild(empty);
      return;
    }
    config.repos.forEach(function (repo, index) {
      var row = el('tr');
      var alias = inputEl(repo.alias, '别名');
      alias.addEventListener('input', function () { repo.alias = alias.value; });
      var path = inputEl(repo.path, '/abs/path');
      path.addEventListener('input', function () { repo.path = path.value; });
      var branch = inputEl(repo.baseBranch, 'main');
      branch.addEventListener('input', function () { repo.baseBranch = branch.value; });
      var remote = inputEl(repo.remote, 'origin');
      remote.addEventListener('input', function () { repo.remote = remote.value; });
      cell(row, alias); cell(row, path); cell(row, branch); cell(row, remote);
      var del = el('button', 'danger', '删除');
      del.addEventListener('click', function () {
        config.repos.splice(index, 1);
        renderRepoRows();
        renderScheduleRows();
      });
      cell(row, del);
      body.appendChild(row);
    });
  }
  function renderScheduleRows() {
    var body = document.getElementById('config-schedules');
    body.textContent = '';
    if (!config.schedules.length) {
      var empty = el('tr');
      var td = el('td', 'muted', '（未配置定时任务）');
      td.colSpan = 6;
      empty.appendChild(td);
      body.appendChild(empty);
      return;
    }
    config.schedules.forEach(function (job, index) {
      var row = el('tr');
      var id = inputEl(job.id, 'id');
      id.addEventListener('input', function () { job.id = id.value; });
      var cron = inputEl(job.cron, '*/30 * * * *');
      cron.addEventListener('input', function () { job.cron = cron.value; });
      var repoSelect = el('select');
      var none = el('option', null, '（默认）');
      none.value = '';
      repoSelect.appendChild(none);
      config.repos.forEach(function (repo) {
        var option = el('option', null, repo.alias);
        option.value = repo.alias;
        repoSelect.appendChild(option);
      });
      repoSelect.value = job.repo || '';
      repoSelect.addEventListener('change', function () { job.repo = repoSelect.value; });
      var prompt = el('textarea');
      prompt.value = job.prompt;
      prompt.addEventListener('input', function () { job.prompt = prompt.value; });
      var enabled = el('input');
      enabled.type = 'checkbox';
      enabled.checked = job.enabled !== false;
      enabled.addEventListener('change', function () { job.enabled = enabled.checked; });
      cell(row, id); cell(row, cron); cell(row, repoSelect); cell(row, prompt, 'prompt'); cell(row, enabled);
      var del = el('button', 'danger', '删除');
      del.addEventListener('click', function () {
        config.schedules.splice(index, 1);
        renderScheduleRows();
      });
      cell(row, del);
      body.appendChild(row);
    });
  }
  function renderConfig(data) {
    document.getElementById('config-path').textContent = data.path;
    document.getElementById('config-note').textContent = data.schedulerConfigured
      ? '保存后需要重启 pisa 才生效。extraArgs 与 envAllow 请直接改文件。'
      : '保存后需要重启 pisa 才生效。当前文件没有 scheduler 身份（chatId/userId），定时任务不会运行。';
    config.repos = data.repos.map(function (repo) {
      return { alias: repo.alias, path: repo.path, remote: repo.remote || '', baseBranch: repo.baseBranch || '' };
    });
    config.schedules = data.schedules.map(function (job) {
      return { id: job.id, cron: job.cron, prompt: job.prompt, repo: job.repo || '', enabled: job.enabled !== false };
    });
    renderRepoRows();
    renderScheduleRows();
    document.getElementById('worker-adapter').value = data.worker.adapter;
    document.getElementById('worker-command').value = data.worker.command;
    document.getElementById('worker-concurrency').value = data.worker.concurrency;
    document.getElementById('worker-timeout').value = data.worker.timeoutSec;
    document.getElementById('worker-extra').textContent = 'extraArgs ' +
      (data.worker.extraArgs.length ? data.worker.extraArgs.join(' ') : '（空）') +
      ' · envAllow ' + data.worker.envAllow.join(',');
  }
  function showConfigErrors(message) {
    var box = document.getElementById('config-errors');
    box.textContent = '';
    var list = Array.isArray(message) ? message : message ? [message] : [];
    list.forEach(function (line) { box.appendChild(el('div', null, '· ' + line)); });
  }
  async function loadConfigForm() {
    try {
      renderConfig(await api('/api/config'));
      showConfigErrors([]);
    } catch (err) {
      showConfigErrors(['读取配置失败：' + err.message]);
    }
  }
  function collectPatch() {
    function intValue(id, label) {
      var raw = document.getElementById(id).value.trim();
      var n = Number(raw);
      if (!raw || !Number.isFinite(n) || Math.floor(n) !== n) throw new Error(label + ' 需要整数，当前：' + raw);
      return n;
    }
    return {
      repos: config.repos.map(function (repo) {
        return { alias: repo.alias.trim(), path: repo.path.trim(), remote: repo.remote.trim(), baseBranch: repo.baseBranch.trim() };
      }),
      worker: {
        adapter: document.getElementById('worker-adapter').value.trim(),
        command: document.getElementById('worker-command').value.trim(),
        concurrency: intValue('worker-concurrency', '并发'),
        timeoutSec: intValue('worker-timeout', '超时')
      },
      schedules: config.schedules.map(function (job) {
        return { id: job.id.trim(), cron: job.cron.trim(), prompt: job.prompt.trim(), repo: job.repo, enabled: job.enabled !== false };
      })
    };
  }
  async function saveConfig() {
    var patch;
    try {
      patch = collectPatch();
    } catch (err) {
      showConfigErrors([err.message]);
      return;
    }
    var path = document.getElementById('config-path').textContent;
    if (!confirm('保存配置到 ' + path + '？\\n\\n保存只改文件，重启 pisa 后才生效。')) return;
    state.busy = true;
    toast('保存中…');
    try {
      var res = await api('/api/config', { method: 'POST', body: JSON.stringify({ confirm: true, patch: patch }) });
      showConfigErrors([]);
      toast(res.message || '已保存，重启后生效');
      await loadConfigForm();
      await loadAudit();
    } catch (err) {
      showConfigErrors((err.data && err.data.errors) || [err.message]);
      toast(err.message, true);
    } finally {
      state.busy = false;
    }
  }
  function renderAudit(data) {
    document.getElementById('audit-path').textContent = data.file;
    var body = document.getElementById('rows-audit');
    body.textContent = '';
    var entries = data.entries || [];
    if (!entries.length) {
      var empty = el('tr');
      var td = el('td', 'muted', '（还没有记录）');
      td.colSpan = 5;
      empty.appendChild(td);
      body.appendChild(empty);
      return;
    }
    entries.slice().reverse().forEach(function (entry) {
      var row = el('tr');
      cell(row, el('span', null, timeText(entry.ts)), 'num');
      cell(row, el('span', null, entry.action));
      cell(row, el('span', null, entry.target), 'num');
      cell(row, el('span', entry.ok ? 'ok' : 'bad', entry.ok ? '成功' : '失败'));
      cell(row, el('span', entry.ok ? 'muted' : 'bad', entry.detail || '-'), 'prompt');
      body.appendChild(row);
    });
  }
  async function loadAudit() {
    try {
      renderAudit(await api('/api/audit?limit=50'));
    } catch (err) {
      toast('审计加载失败：' + err.message, true);
    }
  }
  function timeText(value) {
    return value ? new Date(value).toLocaleString() : '-';
  }
  function detailRow(dl, key, value) {
    dl.appendChild(el('dt', null, key));
    var dd = el('dd');
    if (value instanceof Node) dd.appendChild(value); else dd.textContent = value === null || value === undefined || value === '' ? '-' : String(value);
    dl.appendChild(dd);
  }
  function renderDetail(data) {
    state.detail = data.task;
    var box = document.getElementById('detail');
    box.textContent = '';
    box.hidden = false;
    var head = el('h2');
    head.appendChild(el('span', null, '任务 ' + data.task.id));
    var headSpacer = el('span', 'spacer');
    head.appendChild(headSpacer);
    var copy = el('button', null, '复制任务号');
    copy.addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(data.task.id);
        toast('已复制 ' + data.task.id);
      } catch (err) {
        toast('复制失败，请手动选择', true);
      }
    });
    var reload = el('button', null, '刷新');
    reload.addEventListener('click', function () { openDetail(data.task.id); });
    var close = el('button', null, '关闭');
    close.addEventListener('click', function () { box.hidden = true; state.detail = null; });
    head.appendChild(copy);
    head.appendChild(reload);
    head.appendChild(close);
    box.appendChild(head);

    var dl = el('dl');
    detailRow(dl, '状态', data.task.statusLabel);
    detailRow(dl, '阶段', data.task.stage + '（' + data.task.stageLabel + '）');
    detailRow(dl, '仓库', data.task.repo);
    detailRow(dl, '耗时', data.task.duration);
    detailRow(dl, '分支', data.task.branch);
    if (data.task.prUrl) {
      var pr = el('a', null, data.task.prUrl);
      pr.href = data.task.prUrl;
      pr.target = '_blank';
      pr.rel = 'noopener';
      detailRow(dl, 'PR', pr);
    }
    detailRow(dl, '主干', data.task.baseRef);
    detailRow(dl, '创建', timeText(data.task.createdAt));
    detailRow(dl, '开始', timeText(data.task.startedAt));
    detailRow(dl, '结束', timeText(data.task.endedAt));
    detailRow(dl, '摘要', data.task.summary);
    if (data.task.error) detailRow(dl, '错误', data.task.error);
    detailRow(dl, '副作用', data.effects.length ? data.effects.map(function (e) { return e.kind + ' ' + e.target; }).join('；') : '无');
    box.appendChild(dl);

    var actions = el('div', 'row');
    var cancel = el('button', 'danger', '取消任务');
    var cancellable = data.task.status === 'queued' || data.task.status === 'running' || data.task.status === 'paused';
    cancel.disabled = !cancellable;
    cancel.addEventListener('click', function () {
      if (!confirm('取消任务 ' + data.task.id + '？')) return;
      writeAction('/api/tasks/' + data.task.id + '/cancel', { confirm: true }, '已取消 ' + data.task.id);
    });
    var merge = el('button', 'primary', '合并到主干');
    merge.disabled = data.task.status !== 'succeeded' || !data.task.branch;
    merge.addEventListener('click', function () {
      var tips = '把 ' + data.task.branch + ' 合并到 ' + (data.task.baseRef || '主干') + '？\\n\\n合并会先验证（有测试就跑测试），通过后快进主干；失败不会改动主干。';
      if (!confirm(tips)) return;
      writeAction('/api/tasks/' + data.task.id + '/merge', { confirm: true }, '已合并 ' + data.task.id);
    });
    var rewind = el('button', 'danger', '撤销…');
    rewind.disabled = !(data.task.status === 'succeeded' || data.task.status === 'failed' || data.task.status === 'cancelled');
    rewind.addEventListener('click', async function () {
      state.busy = true;
      try {
        var preview = await api('/api/tasks/' + encodeURIComponent(data.task.id) + '/rewind');
        if (!confirm(preview.text)) return;
        toast('撤销中…');
        var res = await api('/api/tasks/' + encodeURIComponent(data.task.id) + '/rewind', {
          method: 'POST',
          body: JSON.stringify({ confirm: true })
        });
        toast(res.message);
        await loadBoard();
        await openDetail(data.task.id);
        await loadAudit();
      } catch (err) {
        toast(err.message, true);
      } finally {
        state.busy = false;
      }
    });
    actions.appendChild(cancel);
    actions.appendChild(merge);
    actions.appendChild(rewind);
    box.appendChild(actions);

    box.appendChild(el('h2', null, 'Prompt'));
    var prompt = el('pre', null, data.task.prompt);
    box.appendChild(prompt);
    box.appendChild(el('h2', null, '日志尾部（最后 ' + data.logTail.length + ' 行）'));
    box.appendChild(el('pre', null, data.logTail.length ? data.logTail.join('\\n') : '（还没有日志）'));
  }
  async function openDetail(id) {
    try {
      renderDetail(await api('/api/tasks/' + encodeURIComponent(id)));
    } catch (err) {
      toast(err.message, true);
    }
  }
  async function writeAction(path, body, doneText) {
    state.busy = true;
    toast('执行中…');
    document.body.style.cursor = 'progress';
    try {
      var res = await api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      toast(res.message || doneText);
    } catch (err) {
      toast(err.message, true);
    } finally {
      state.busy = false;
      document.body.style.cursor = '';
      await loadBoard();
      if (state.detail) await openDetail(state.detail.id);
      await loadAudit();
    }
  }
  async function dispatch() {
    var area = document.getElementById('prompt');
    var text = area.value.trim();
    var msg = document.getElementById('dispatch-msg');
    if (!text) { msg.textContent = '任务内容不能为空'; msg.className = 'bad'; return; }
    if (!confirm('派活到 ' + (state.repo || '默认仓库') + '？\\n\\n' + text)) return;
    var button = document.getElementById('send');
    button.disabled = true;
    msg.className = 'muted';
    msg.textContent = '提交中…';
    state.busy = true;
    try {
      var body = { prompt: text, confirm: true };
      if (state.repo) body.repo = state.repo;
      var res = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
      area.value = '';
      msg.textContent = '已接单 · ' + (res.taskId || '');
      msg.className = 'ok';
      await loadBoard();
      await loadAudit();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'bad';
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  }
  function refreshAll() {
    loadBoard();
    loadMetrics();
    loadAudit();
  }
  document.getElementById('refresh').addEventListener('click', refreshAll);
  document.getElementById('repo').addEventListener('change', function (event) {
    state.repo = event.target.value;
    loadBoard();
  });
  document.getElementById('send').addEventListener('click', dispatch);
  document.getElementById('prompt').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      dispatch();
    }
  });
  document.getElementById('add-repo').addEventListener('click', function () {
    config.repos.push({ alias: '', path: '', remote: '', baseBranch: '' });
    renderRepoRows();
    renderScheduleRows();
  });
  document.getElementById('add-schedule').addEventListener('click', function () {
    config.schedules.push({ id: '', cron: '', prompt: '', repo: '', enabled: true });
    renderScheduleRows();
  });
  document.getElementById('load-config').addEventListener('click', loadConfigForm);
  document.getElementById('save-config').addEventListener('click', saveConfig);
  loadBoard();
  loadMetrics();
  loadAudit();
  loadConfigForm();
  setInterval(function () {
    if (!state.busy && !document.hidden) refreshAll();
  }, 5000);
})();
</script>
</body>
</html>
`;
