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
  button, select, textarea { font: inherit; color: inherit; }
  button { border: 1px solid var(--line); background: transparent; border-radius: 6px; padding: 3px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger:hover { border-color: var(--bad); color: var(--bad); }
  button:disabled { opacity: .45; cursor: default; border-color: var(--line); color: inherit; }
  button.link { border: 0; padding: 0; color: var(--accent); }
  textarea { width: 100%; min-height: 68px; resize: vertical; border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: transparent; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  pre { margin: 0; padding: 8px; border: 1px solid var(--line); border-radius: 6px; overflow: auto; max-height: 360px; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0 0 12px; font-size: 13px; }
  dt { color: var(--muted); }
  dd { margin: 0; word-break: break-all; }
  #detail { border-color: var(--accent); }
  #toast { position: fixed; right: 16px; bottom: 16px; max-width: 420px; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); box-shadow: 0 4px 16px rgba(0,0,0,.15); font-size: 13px; white-space: pre-wrap; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  .charts h3 { font-size: 13px; margin: 0 0 4px; font-weight: 500; }
  .chart { display: flex; align-items: flex-end; gap: 3px; height: 88px; border-bottom: 1px solid var(--line); }
  .chart .bar { flex: 1; display: flex; align-items: flex-end; height: 100%; }
  .chart .bar i { display: block; width: 100%; background: var(--accent); border-radius: 2px 2px 0 0; }
  .chart .bar.bad i { background: var(--bad); }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 12px; margin: 8px 0; }
  .form-grid label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); }
  input { font: inherit; color: inherit; border: 1px solid var(--line); border-radius: 4px; padding: 3px 6px; background: transparent; min-width: 0; }
  td input[type=text], td input[type=number] { width: 100%; }
  td input[type=number] { max-width: 90px; }
  #config-note { white-space: pre-wrap; }
  #rewind-actions { margin: 4px 0 8px; padding-left: 20px; font-size: 13px; }
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

  <section>
    <h2>指标 <span id="metrics-note" class="badge"></span></h2>
    <div class="charts">
      <div><h3>成功率</h3><div id="chart-success"></div><div class="muted">每根柱一天，红色为当天有失败</div></div>
      <div><h3>平均耗时（秒）</h3><div id="chart-duration"></div><div class="muted">只算成功且有起止时间的任务</div></div>
      <div><h3>队列深度</h3><div id="chart-queue"></div><div class="muted">当天结束时仍在排队的任务数</div></div>
    </div>
  </section>

  <section id="config">
    <h2>配置 <span id="config-path" class="badge"></span></h2>
    <div class="row">
      <span id="config-note" class="muted">改完保存；调度与并发在重启守护进程后生效</span>
      <div class="spacer"></div>
      <button id="config-reload">重新读取</button>
      <button id="config-save" class="primary">保存配置</button>
    </div>
    <h2 style="margin-top:12px">仓库</h2>
    <table><thead><tr><th>别名</th><th>路径</th><th>基线分支</th><th>远端</th><th></th></tr></thead><tbody id="rows-repos"></tbody></table>
    <div class="row"><button id="add-repo">添加仓库</button></div>
    <h2 style="margin-top:12px">Worker</h2>
    <div class="form-grid">
      <label>适配器<input id="w-adapter" type="text"></label>
      <label>命令<input id="w-command" type="text"></label>
      <label>并发<input id="w-concurrency" type="number" min="1" max="32"></label>
      <label>单任务超时（秒）<input id="w-timeout" type="number" min="1" max="86400"></label>
    </div>
    <h2 style="margin-top:12px">定时任务</h2>
    <table><thead><tr><th>id</th><th>cron</th><th>内容</th><th>仓库</th><th>启用</th><th></th></tr></thead><tbody id="rows-schedules"></tbody></table>
    <div class="row"><button id="add-schedule">添加定时任务</button></div>
  </section>

  <section>
    <h2>审计 <span id="count-audit" class="badge"></span></h2>
    <table><thead><tr><th>时间</th><th>操作</th><th>对象</th><th>结果</th><th>详情</th></tr></thead><tbody id="rows-audit"></tbody></table>
  </section>

  <section id="detail" hidden></section>
</main>
<div id="toast" hidden></div>

<script>
(function () {
  'use strict';
  var state = { repo: '', busy: false, detail: null };
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
    if (!res.ok || data.ok === false) throw new Error(data.message || data.error || ('HTTP ' + res.status));
    return data;
  }
  function cell(row, child, cls) {
    var td = el('td', cls);
    td.appendChild(child);
    row.appendChild(td);
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
  function barChart(boxId, days, pick, format, badWhen) {
    var box = document.getElementById(boxId);
    box.textContent = '';
    var max = 0;
    days.forEach(function (d) { max = Math.max(max, pick(d)); });
    var chart = el('div', 'chart');
    days.forEach(function (d) {
      var v = pick(d);
      var bar = el('div', 'bar' + (badWhen && badWhen(d) ? ' bad' : ''));
      var fill = el('i');
      fill.style.height = (max > 0 && v > 0 ? Math.max(3, Math.round(v / max * 100)) : 0) + '%';
      bar.appendChild(fill);
      bar.title = d.date + '：' + format(d, v);
      chart.appendChild(bar);
    });
    box.appendChild(chart);
  }
  function renderMetrics(data) {
    var days = data.metrics || [];
    var last = days[days.length - 1];
    document.getElementById('metrics-note').textContent = last
      ? days.length + ' 天 · 最近一天 ' + last.total + ' 条，成功 ' + last.succeeded + '，失败 ' + last.failed
      : '还没有数据';
    barChart('chart-success', days,
      function (d) { return d.successRate === null ? 0 : Math.round(d.successRate * 100); },
      function (d, v) { return d.successRate === null ? '无已完成任务' : v + '%（成功 ' + d.succeeded + ' / 失败 ' + d.failed + '）'; },
      function (d) { return d.failed > 0; });
    barChart('chart-duration', days,
      function (d) { return d.avgDurationMs ? Math.round(d.avgDurationMs / 1000) : 0; },
      function (d) { return d.avgDurationMs === null ? '无成功任务' : Math.round(d.avgDurationMs / 1000) + 's'; });
    barChart('chart-queue', days,
      function (d) { return d.queueDepth; },
      function (d, v) { return v + ' 条'; });
  }
  async function loadMetrics() {
    try {
      renderMetrics(await api('/api/metrics?days=14'));
    } catch (err) {
      document.getElementById('metrics-note').textContent = '指标加载失败：' + err.message;
    }
  }
  function fieldValue(id) {
    return document.getElementById(id).value.trim();
  }
  function inputCell(row, field, value, type) {
    var td = el('td');
    var input = el('input');
    input.type = type || 'text';
    if (type === 'checkbox') input.checked = !!value;
    else input.value = value === undefined || value === null ? '' : String(value);
    input.dataset.field = field;
    td.appendChild(input);
    row.appendChild(td);
    return input;
  }
  function deleteCell(row) {
    var td = el('td');
    var del = el('button', 'danger', '删除');
    del.addEventListener('click', function () { row.remove(); });
    td.appendChild(del);
    row.appendChild(td);
  }
  function repoRow(repo) {
    var row = el('tr');
    inputCell(row, 'alias', repo.alias);
    inputCell(row, 'path', repo.path);
    inputCell(row, 'baseBranch', repo.baseBranch);
    inputCell(row, 'remote', repo.remote);
    deleteCell(row);
    return row;
  }
  function scheduleRow(job) {
    var row = el('tr');
    inputCell(row, 'id', job.id);
    inputCell(row, 'cron', job.cron);
    inputCell(row, 'prompt', job.prompt);
    inputCell(row, 'repo', job.repo);
    inputCell(row, 'enabled', job.enabled !== false, 'checkbox');
    deleteCell(row);
    return row;
  }
  function fillRepos(repos) {
    var body = document.getElementById('rows-repos');
    body.textContent = '';
    (repos || []).forEach(function (repo) { body.appendChild(repoRow(repo)); });
    if (!body.children.length) body.appendChild(repoRow({}));
  }
  function fillSchedules(jobs) {
    var body = document.getElementById('rows-schedules');
    body.textContent = '';
    (jobs || []).forEach(function (job) { body.appendChild(scheduleRow(job)); });
  }
  function fillWorker(worker) {
    document.getElementById('w-adapter').value = worker.adapter || '';
    document.getElementById('w-command').value = worker.command || '';
    document.getElementById('w-concurrency').value = String(worker.concurrency);
    document.getElementById('w-timeout').value = String(worker.timeoutSec);
  }
  async function loadConfig() {
    var note = document.getElementById('config-note');
    try {
      var data = await api('/api/config');
      state.configPath = data.path;
      document.getElementById('config-path').textContent = data.path;
      document.getElementById('config-save').disabled = false;
      note.textContent = '改完保存；调度与并发在重启守护进程后生效';
      note.className = 'muted';
      fillRepos(data.config.repos);
      fillWorker(data.config.worker);
      fillSchedules(data.config.schedules);
    } catch (err) {
      document.getElementById('config-path').textContent = '不可用';
      document.getElementById('config-save').disabled = true;
      note.textContent = err.message;
      note.className = 'bad';
    }
  }
  function readRows(bodyId) {
    var out = [];
    document.querySelectorAll('#' + bodyId + ' tr').forEach(function (tr) {
      var item = {};
      var filled = false;
      tr.querySelectorAll('[data-field]').forEach(function (node) {
        var name = node.dataset.field;
        if (node.type === 'checkbox') item[name] = node.checked;
        else {
          item[name] = node.value.trim();
          if (item[name]) filled = true;
        }
      });
      if (filled) out.push(item);
    });
    return out;
  }
  function configPayload() {
    return {
      repos: readRows('rows-repos').map(function (r) {
        var repo = { alias: r.alias, path: r.path };
        if (r.baseBranch) repo.baseBranch = r.baseBranch;
        if (r.remote) repo.remote = r.remote;
        return repo;
      }),
      worker: {
        adapter: fieldValue('w-adapter'),
        command: fieldValue('w-command'),
        concurrency: Number(fieldValue('w-concurrency')),
        timeoutSec: Number(fieldValue('w-timeout'))
      },
      schedules: readRows('rows-schedules').map(function (s) {
        var job = { id: s.id, cron: s.cron, prompt: s.prompt, enabled: s.enabled };
        if (s.repo) job.repo = s.repo;
        return job;
      })
    };
  }
  async function saveConfig() {
    var note = document.getElementById('config-note');
    var payload = configPayload();
    var repos = payload.repos.map(function (r) { return r.alias || '(未命名)'; }).join('、') || '(空)';
    var jobs = payload.schedules.map(function (s) { return s.id + (s.enabled ? '' : '(停用)'); }).join('、') || '无';
    var tips = '写回 ' + state.configPath + '？\\n\\n仓库：' + repos +
      '\\n并发：' + payload.worker.concurrency + '，超时：' + payload.worker.timeoutSec + 's' +
      '\\n定时任务：' + jobs + '\\n\\n保存后需重启守护进程生效。';
    if (!confirm(tips)) return;
    note.textContent = '保存中…';
    note.className = 'muted';
    try {
      var res = await fetch(withToken('/api/config'), {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, config: payload })
      });
      if (res.status === 401) { showAuth(); throw new Error('未授权'); }
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || data.ok === false) {
        var errors = data.errors && data.errors.length ? data.errors : [data.error || ('HTTP ' + res.status)];
        note.textContent = errors.join('\\n');
        note.className = 'bad';
        toast('配置未保存', true);
        return;
      }
      note.textContent = (data.message || '已保存') + (data.summary ? '\\n' + data.summary : '');
      note.className = 'ok';
      toast('配置已保存，重启后生效');
      await loadConfig();
      await loadAudit();
    } catch (err) {
      note.textContent = err.message;
      note.className = 'bad';
    }
  }
  function renderAudit(data) {
    var body = document.getElementById('rows-audit');
    body.textContent = '';
    var entries = data.entries || [];
    document.getElementById('count-audit').textContent = entries.length + ' 条（最新在前）';
    if (!entries.length) {
      var empty = el('tr');
      var td = el('td', 'muted', '（还没有写操作）');
      td.colSpan = 5;
      empty.appendChild(td);
      body.appendChild(empty);
      return;
    }
    entries.forEach(function (entry) {
      var row = el('tr');
      cell(row, el('span', null, timeText(entry.at)), 'num');
      cell(row, el('span', null, entry.action));
      cell(row, el('span', null, entry.target));
      cell(row, el('span', entry.ok ? 'ok' : 'bad', entry.ok ? '成功' : '失败'));
      var detail = el('div', 'prompt', entry.detail || '-');
      detail.title = entry.detail || '';
      cell(row, detail, 'prompt');
      body.appendChild(row);
    });
  }
  async function loadAudit() {
    try {
      renderAudit(await api('/api/audit?limit=20'));
    } catch (err) {
      document.getElementById('count-audit').textContent = '审计加载失败：' + err.message;
    }
  }
  function rewindPanel(box, task) {
    var panel = el('div');
    var head = el('h2', null, '撤销');
    var status = el('div', 'muted', '读取预览…');
    var list = el('ul');
    list.id = 'rewind-actions';
    var notes = el('div', 'muted');
    var run = el('button', 'danger', '执行撤销');
    run.disabled = true;
    panel.appendChild(head);
    panel.appendChild(status);
    panel.appendChild(list);
    panel.appendChild(notes);
    panel.appendChild(run);
    box.appendChild(panel);
    api('/api/tasks/' + encodeURIComponent(task.id) + '/rewind').then(function (data) {
      var plan = data.rewind;
      status.textContent = '合并状态：' + plan.mergeLabel;
      if (!plan.actions.length) list.appendChild(el('li', 'muted', '没有会自动撤销的副作用'));
      plan.actions.forEach(function (label) { list.appendChild(el('li', null, label)); });
      if (plan.irreversible.length) {
        notes.className = 'bad';
        notes.textContent = '不可撤销：' + plan.irreversible.join('；');
      }
      if (!plan.actions.length) return;
      run.disabled = false;
      run.addEventListener('click', function () {
        var tips = '撤销 ' + task.id + ' 将执行 ' + plan.actions.length + ' 个动作：\\n\\n' +
          plan.actions.join('\\n') + '\\n\\n不可撤销：' + (plan.irreversible.join('；') || '无') + '\\n\\n继续？';
        if (!confirm(tips)) return;
        writeAction('/api/tasks/' + encodeURIComponent(task.id) + '/rewind', { confirm: true }, '已撤销 ' + task.id);
      });
    }).catch(function (err) {
      status.textContent = '无法撤销：' + err.message;
      status.className = 'muted bad';
    });
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
    actions.appendChild(cancel);
    actions.appendChild(merge);
    box.appendChild(actions);

    var finished = data.task.status === 'succeeded' || data.task.status === 'failed' || data.task.status === 'cancelled';
    if (finished) rewindPanel(box, data.task);

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
      await loadMetrics();
      await loadAudit();
      if (state.detail) await openDetail(state.detail.id);
    }
  }
  async function dispatch() {
    var area = document.getElementById('prompt');
    var text = area.value.trim();
    var msg = document.getElementById('dispatch-msg');
    if (!text) { msg.textContent = '任务内容不能为空'; msg.className = 'bad'; return; }
    var button = document.getElementById('send');
    button.disabled = true;
    msg.className = 'muted';
    msg.textContent = '提交中…';
    state.busy = true;
    try {
      if (!confirm('派活到 ' + (state.repo || '默认仓库') + '？\\n\\n' + text)) {
        msg.textContent = '已取消';
        msg.className = 'muted';
        return;
      }
      var body = { prompt: text, confirm: true };
      if (state.repo) body.repo = state.repo;
      var res = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
      area.value = '';
      msg.textContent = '已接单 · ' + (res.taskId || '');
      msg.className = 'ok';
      await loadBoard();
      await loadMetrics();
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
    document.getElementById('rows-repos').appendChild(repoRow({}));
  });
  document.getElementById('add-schedule').addEventListener('click', function () {
    document.getElementById('rows-schedules').appendChild(scheduleRow({ enabled: true }));
  });
  document.getElementById('config-reload').addEventListener('click', loadConfig);
  document.getElementById('config-save').addEventListener('click', saveConfig);
  loadBoard();
  loadMetrics();
  loadAudit();
  loadConfig();
  setInterval(function () {
    if (!state.busy && !document.hidden) {
      loadBoard();
      loadMetrics();
    }
  }, 5000);
})();
</script>
</body>
</html>
`;
