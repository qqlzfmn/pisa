/**
 * 控制台单页：内联样式与原生脚本，不打包、不引框架。
 * 所有数据渲染都走 createElement + textContent，prompt 与日志不经过 innerHTML。
 * 图表用 createElementNS 画原生 SVG；配置表单在有未保存改动时不接受自动重载。
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
  h2 { font-size: 14px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  h3 { font-size: 12px; color: var(--muted); font-weight: 500; margin: 12px 0 6px; }
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
  input[type=text], input[type=number] { border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; background: transparent; width: 100%; min-width: 70px; }
  input[type=checkbox] { width: auto; }
  select { border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; background: transparent; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
  label.block { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-top: 8px; }
  .chart { width: 100%; height: 96px; display: block; }
  .chart .axis { stroke: var(--line); stroke-width: 1; }
  .chart .bar { fill: var(--accent); }
  .chart .bar.alt { fill: var(--ok); }
  .chart .line { fill: none; stroke: var(--accent); stroke-width: 1.5; }
  .chart-box h3 { display: flex; gap: 8px; align-items: baseline; }
  pre { margin: 0; padding: 8px; border: 1px solid var(--line); border-radius: 6px; overflow: auto; max-height: 360px; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0 0 12px; font-size: 13px; }
  dt { color: var(--muted); }
  dd { margin: 0; word-break: break-all; }
  #detail { border-color: var(--accent); }
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
    <h2>趋势 <span id="metrics-badge" class="badge"></span>
      <span class="spacer"></span>
      <select id="metrics-hours">
        <option value="6">6 小时</option>
        <option value="24" selected>24 小时</option>
        <option value="168">7 天</option>
      </select>
    </h2>
    <div id="metrics-summary" class="muted">加载中…</div>
    <div id="charts" class="charts"></div>
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
    <h2>配置 <span id="config-badge" class="badge"></span>
      <span class="spacer"></span>
      <button id="config-reload">重新载入</button>
      <button id="config-revert">恢复生效值</button>
      <button id="config-save" class="primary">保存配置</button>
    </h2>
    <div id="config-errors" class="bad"></div>
    <div id="config-body" class="muted">加载中…</div>
  </section>

  <section>
    <h2>审计 <span id="audit-badge" class="badge"></span></h2>
    <table><thead><tr><th>时间</th><th>动作</th><th>对象</th><th>操作者</th><th>详情</th></tr></thead><tbody id="rows-audit"></tbody></table>
  </section>
</main>
<div id="toast" hidden></div>

<script>
(function () {
  'use strict';
  var state = { repo: '', busy: false, detail: null, metricsHours: 24, configDirty: false, config: null };
  var token = new URLSearchParams(location.search).get('token');
  if (token) history.replaceState(null, '', location.pathname);

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function svgEl(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]); });
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
      var text = data.message || data.error || (data.errors && data.errors.join('；')) || ('HTTP ' + res.status);
      var error = new Error(text);
      error.data = data;
      throw error;
    }
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

  function fmtNumber(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }
  function fmtDuration(ms) {
    if (ms === null || ms === undefined) return '-';
    var sec = Math.round(ms / 1000);
    if (sec < 60) return sec + 's';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'm' + (sec % 60 ? (sec % 60) + 's' : '');
    return Math.floor(min / 60) + 'h' + (min % 60 ? (min % 60) + 'm' : '');
  }
  function chartFrame() {
    var svg = svgEl('svg', { viewBox: '0 0 300 96', class: 'chart', preserveAspectRatio: 'none' });
    svg.appendChild(svgEl('line', { x1: 0, y1: 95.5, x2: 300, y2: 95.5, class: 'axis' }));
    return svg;
  }
  function chartMax(values) {
    return Math.max.apply(null, values.filter(function (v) { return v !== null && v !== undefined; }).concat([1]));
  }
  function barChart(buckets, pick, cls) {
    var values = buckets.map(pick);
    var max = chartMax(values);
    var svg = chartFrame();
    var slot = 300 / Math.max(1, buckets.length);
    values.forEach(function (v, i) {
      if (v === null || v === undefined) return;
      var height = Math.max(1, (v / max) * 92);
      svg.appendChild(svgEl('rect', {
        x: i * slot + slot * 0.15,
        y: 94 - height,
        width: Math.max(1, slot * 0.7),
        height: height,
        class: cls
      }));
    });
    return { node: svg, max: max, latest: values.length ? values[values.length - 1] : null };
  }
  function lineChart(buckets, pick) {
    var values = buckets.map(pick);
    var max = chartMax(values);
    var svg = chartFrame();
    var slot = 300 / Math.max(1, buckets.length);
    var path = '';
    var pen = false;
    values.forEach(function (v, i) {
      if (v === null || v === undefined) { pen = false; return; }
      var x = (i + 0.5) * slot;
      var y = 94 - (v / max) * 92;
      path += (pen ? ' L ' : ' M ') + x.toFixed(1) + ' ' + y.toFixed(1);
      pen = true;
    });
    if (path) svg.appendChild(svgEl('path', { d: path.trim(), class: 'line' }));
    return { node: svg, max: max, latest: values.length ? values[values.length - 1] : null };
  }
  function chartBox(title, unit, chart) {
    var box = el('div', 'chart-box');
    var head = el('h3');
    head.appendChild(el('span', null, title));
    head.appendChild(el('span', 'badge', '峰值 ' + fmtNumber(chart.max) + unit +
      (chart.latest === null || chart.latest === undefined ? '' : ' · 最近 ' + fmtNumber(chart.latest) + unit)));
    box.appendChild(head);
    box.appendChild(chart.node);
    return box;
  }
  function renderMetrics(data) {
    var totals = data.totals;
    var summary = data.hours + ' 小时：完成 ' + totals.finished + ' · 成功 ' + totals.succeeded + ' · 失败 ' + totals.failed;
    if (totals.successRate !== null) summary += ' · 成功率 ' + Math.round(totals.successRate * 100) + '%';
    if (totals.p50Ms !== null) summary += ' · p50 ' + fmtDuration(totals.p50Ms) + ' · p95 ' + fmtDuration(totals.p95Ms);
    document.getElementById('metrics-summary').textContent = summary;
    document.getElementById('metrics-badge').textContent = '每格 ' + Math.round((data.hours * 60) / data.buckets) + ' 分钟';
    var charts = document.getElementById('charts');
    charts.textContent = '';
    var buckets = data.series;
    charts.appendChild(chartBox('成功率', '%', barChart(buckets, function (b) {
      return b.successRate === null ? null : Math.round(b.successRate * 100);
    }, 'bar alt')));
    charts.appendChild(chartBox('p50 耗时', 's', lineChart(buckets, function (b) {
      return b.p50Ms === null ? null : b.p50Ms / 1000;
    })));
    charts.appendChild(chartBox('队列深度峰值', '', barChart(buckets, function (b) {
      return b.queueMax;
    }, 'bar')));
  }
  async function loadMetrics() {
    try {
      var buckets = state.metricsHours > 48 ? 84 : 24;
      renderMetrics(await api('/api/metrics?hours=' + state.metricsHours + '&buckets=' + buckets));
    } catch (err) {
      document.getElementById('metrics-summary').textContent = '加载失败：' + err.message;
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
  function renderRewind(box, taskId) {
    box.className = 'muted';
    box.textContent = '预览中…';
    api('/api/tasks/' + encodeURIComponent(taskId) + '/rewind').then(function (data) {
      var plan = data.plan;
      box.className = '';
      box.textContent = '';
      box.appendChild(el('p', 'muted', '合并：' + plan.mergeLabel));
      if (!plan.actions.length) {
        box.appendChild(el('p', 'muted', '没有可撤销的副作用。'));
      } else {
        var list = el('ol');
        plan.actions.forEach(function (action) { list.appendChild(el('li', null, action.label)); });
        box.appendChild(list);
        var run = el('button', 'danger', '执行撤销');
        run.addEventListener('click', function () {
          if (!confirm('撤销 ' + taskId + '？\\n\\n将逐条执行上面的动作；执行后无法撤回。')) return;
          writeAction('/api/tasks/' + taskId + '/rewind', { confirm: true }, '已撤销 ' + taskId);
        });
        box.appendChild(run);
      }
      if (plan.irreversible.length) {
        box.appendChild(el('p', 'muted', '不可撤销'));
        var bad = el('ul', 'bad');
        plan.irreversible.forEach(function (line) { bad.appendChild(el('li', null, line)); });
        box.appendChild(bad);
      }
      if (plan.notes.length) {
        box.appendChild(el('p', 'muted', '保留'));
        var notes = el('ul');
        plan.notes.forEach(function (line) { notes.appendChild(el('li', null, line)); });
        box.appendChild(notes);
      }
    }).catch(function (err) {
      box.className = 'muted';
      box.textContent = '无法预览撤销：' + err.message;
    });
  }
  function renderDetail(data) {
    state.detail = data.task;
    var box = document.getElementById('detail');
    box.textContent = '';
    box.hidden = false;
    var head = el('h2');
    head.appendChild(el('span', null, '任务 ' + data.task.id));
    head.appendChild(el('span', 'spacer'));
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
      writeAction('/api/tasks/' + data.task.id + '/cancel', null, '已取消 ' + data.task.id);
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

    box.appendChild(el('h2', null, '撤销'));
    var rewindBox = el('div');
    box.appendChild(rewindBox);
    var terminal = data.task.status === 'succeeded' || data.task.status === 'failed' || data.task.status === 'cancelled';
    if (terminal) renderRewind(rewindBox, data.task.id);
    else rewindBox.appendChild(el('p', 'muted', '任务结束后可预览并执行撤销。'));

    box.appendChild(el('h2', null, 'Prompt'));
    box.appendChild(el('pre', null, data.task.prompt));
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
    if (!confirm('派活到 ' + (state.repo || '自动选择的仓库') + '？\\n\\n' + text.slice(0, 200))) return;
    var button = document.getElementById('send');
    button.disabled = true;
    msg.className = 'muted';
    msg.textContent = '提交中…';
    state.busy = true;
    try {
      var body = { prompt: text };
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

  function setConfigBadge(text, bad) {
    var badge = document.getElementById('config-badge');
    badge.textContent = text || '';
    badge.className = bad ? 'badge bad' : 'badge';
  }
  function renderConfigErrors(errors) {
    var box = document.getElementById('config-errors');
    box.textContent = '';
    (errors || []).forEach(function (line) { box.appendChild(el('div', null, line)); });
  }
  function markConfigDirty() {
    state.configDirty = true;
    setConfigBadge('有未保存的改动', true);
  }
  function configInput(group, field, value) {
    var input = el('input');
    input.type = 'text';
    input.value = value === undefined || value === null ? '' : String(value);
    input.dataset.g = group;
    input.dataset.f = field;
    input.addEventListener('input', markConfigDirty);
    return input;
  }
  function repoFormRow(repo) {
    var row = el('tr');
    ['alias', 'path', 'remote', 'baseBranch'].forEach(function (field) {
      var td = el('td');
      td.appendChild(configInput('repo', field, repo[field]));
      row.appendChild(td);
    });
    var ops = el('td');
    var remove = el('button', 'danger', '删除');
    remove.addEventListener('click', function () { row.remove(); markConfigDirty(); });
    ops.appendChild(remove);
    row.appendChild(ops);
    return row;
  }
  function scheduleFormRow(job) {
    var row = el('tr');
    ['id', 'cron', 'prompt', 'repo'].forEach(function (field) {
      var td = el('td');
      td.appendChild(configInput('schedule', field, job[field]));
      row.appendChild(td);
    });
    var enabledCell = el('td');
    var toggle = el('input');
    toggle.type = 'checkbox';
    toggle.dataset.g = 'schedule';
    toggle.dataset.f = 'enabled';
    toggle.checked = job.enabled !== false;
    toggle.addEventListener('change', markConfigDirty);
    enabledCell.appendChild(toggle);
    row.appendChild(enabledCell);
    var ops = el('td');
    var remove = el('button', 'danger', '删除');
    remove.addEventListener('click', function () { row.remove(); markConfigDirty(); });
    ops.appendChild(remove);
    row.appendChild(ops);
    return row;
  }
  function renderConfig(data) {
    state.config = data;
    state.configDirty = false;
    var body = document.getElementById('config-body');
    body.textContent = '';
    body.className = '';
    setConfigBadge(data.pendingRestart ? '有改动未生效：重启守护进程后生效（' + data.path + '）' : '配置文件 ' + data.path, data.pendingRestart);
    renderConfigErrors(data.errors);
    if (!data.draft) return;
    var draft = data.draft;

    body.appendChild(el('h3', null, '仓库'));
    var reposTable = el('table');
    var reposHead = el('tr');
    ['别名', '路径', '远端', '主干', '操作'].forEach(function (label) { reposHead.appendChild(el('th', null, label)); });
    var reposHeadRow = el('thead');
    reposHeadRow.appendChild(reposHead);
    reposTable.appendChild(reposHeadRow);
    var reposBody = el('tbody');
    reposBody.id = 'repos-body';
    draft.repos.forEach(function (repo) { reposBody.appendChild(repoFormRow(repo)); });
    reposTable.appendChild(reposBody);
    body.appendChild(reposTable);
    var addRepo = el('button', null, '添加仓库');
    addRepo.addEventListener('click', function () {
      var row = repoFormRow({});
      reposBody.appendChild(row);
      markConfigDirty();
      row.querySelector('input').focus();
    });
    body.appendChild(addRepo);

    body.appendChild(el('h3', null, 'Worker'));
    var grid = el('div', 'form-grid');
    [['adapter', '代理'], ['command', '命令'], ['concurrency', '并发'], ['timeoutSec', '超时（秒）'], ['idleTimeoutSec', '空闲超时（秒）']].forEach(function (pair) {
      var label = el('label', 'block');
      label.appendChild(el('span', null, pair[1]));
      label.appendChild(configInput('worker', pair[0], draft.worker[pair[0]]));
      grid.appendChild(label);
    });
    body.appendChild(grid);

    body.appendChild(el('h3', null, '定时任务'));
    var schedulesTable = el('table');
    var schedulesHead = el('tr');
    ['id', 'cron', 'prompt', '仓库', '启用', '操作'].forEach(function (label) { schedulesHead.appendChild(el('th', null, label)); });
    var schedulesHeadRow = el('thead');
    schedulesHeadRow.appendChild(schedulesHead);
    schedulesTable.appendChild(schedulesHeadRow);
    var schedulesBody = el('tbody');
    schedulesBody.id = 'schedules-body';
    draft.schedules.forEach(function (job) { schedulesBody.appendChild(scheduleFormRow(job)); });
    schedulesTable.appendChild(schedulesBody);
    body.appendChild(schedulesTable);
    var addSchedule = el('button', null, '添加定时任务');
    addSchedule.addEventListener('click', function () {
      var row = scheduleFormRow({ enabled: true });
      schedulesBody.appendChild(row);
      markConfigDirty();
      row.querySelector('input').focus();
    });
    body.appendChild(addSchedule);
  }
  function readConfigForm() {
    var repos = [];
    Array.prototype.forEach.call(document.querySelectorAll('#repos-body tr'), function (row) {
      function field(name) {
        var node = row.querySelector('[data-f="' + name + '"]');
        return node ? node.value.trim() : '';
      }
      var repo = { alias: field('alias'), path: field('path') };
      if (field('remote')) repo.remote = field('remote');
      if (field('baseBranch')) repo.baseBranch = field('baseBranch');
      repos.push(repo);
    });
    var worker = {};
    ['adapter', 'command', 'concurrency', 'timeoutSec', 'idleTimeoutSec'].forEach(function (name) {
      var node = document.querySelector('#config-body [data-g="worker"][data-f="' + name + '"]');
      worker[name] = node ? node.value.trim() : '';
    });
    var schedules = [];
    Array.prototype.forEach.call(document.querySelectorAll('#schedules-body tr'), function (row) {
      function field(name) {
        var node = row.querySelector('[data-f="' + name + '"]');
        return node ? node.value.trim() : '';
      }
      var job = { id: field('id'), cron: field('cron'), prompt: field('prompt'), enabled: row.querySelector('[data-f="enabled"]').checked };
      if (field('repo')) job.repo = field('repo');
      schedules.push(job);
    });
    return { repos: repos, worker: worker, schedules: schedules };
  }
  async function loadConfig(force) {
    try {
      var data = await api('/api/config');
      if (!force && state.configDirty && state.config) {
        setConfigBadge('有未保存的改动，未重新载入', true);
        return;
      }
      renderConfig(data);
    } catch (err) {
      var body = document.getElementById('config-body');
      body.className = 'bad';
      body.textContent = '加载配置失败：' + err.message;
    }
  }
  async function saveConfig() {
    if (!state.config) return;
    if (!confirm('保存配置到 ' + state.config.path + '？\\n\\n改动需要重启守护进程后才生效。')) return;
    var draft = readConfigForm();
    try {
      var res = await api('/api/config', { method: 'POST', body: JSON.stringify({ confirm: true, draft: draft }) });
      toast(res.message);
      await loadConfig(true);
      await loadAudit();
    } catch (err) {
      renderConfigErrors(err.data && err.data.errors ? err.data.errors : [err.message]);
      setConfigBadge('保存失败，文件未改动', true);
      toast('保存失败：' + err.message, true);
    }
  }
  function revertConfig() {
    if (!state.config) return;
    if (state.configDirty && !confirm('放弃未保存的改动，恢复为当前生效的配置？')) return;
    renderConfig(Object.assign({}, state.config, { draft: state.config.active, pendingRestart: false, errors: [] }));
    setConfigBadge('已恢复为生效值（文件未改动）');
  }

  async function loadAudit() {
    try {
      var data = await api('/api/audit?limit=50');
      var body = document.getElementById('rows-audit');
      body.textContent = '';
      if (!data.entries.length) {
        var row = el('tr');
        var td = el('td', 'muted', '（空）');
        td.colSpan = 5;
        row.appendChild(td);
        body.appendChild(row);
      }
      data.entries.forEach(function (entry) {
        var row = el('tr');
        cell(row, el('span', null, timeText(entry.at)), 'num');
        cell(row, el('span', null, entry.action));
        cell(row, el('span', null, entry.target), 'num');
        cell(row, el('span', null, entry.actor));
        var detail = el('div', 'prompt', entry.detail || '-');
        detail.title = entry.detail || '';
        cell(row, detail, 'prompt');
        body.appendChild(row);
      });
      document.getElementById('audit-badge').textContent = data.entries.length + ' 条（最近 50）';
    } catch (err) {
      document.getElementById('audit-badge').textContent = '加载失败：' + err.message;
    }
  }

  document.getElementById('refresh').addEventListener('click', function () { loadBoard(); loadMetrics(); loadAudit(); });
  document.getElementById('repo').addEventListener('change', function (event) {
    state.repo = event.target.value;
    loadBoard();
  });
  document.getElementById('metrics-hours').addEventListener('change', function (event) {
    state.metricsHours = Number(event.target.value) || 24;
    loadMetrics();
  });
  document.getElementById('config-reload').addEventListener('click', function () {
    if (state.configDirty && !confirm('放弃未保存的改动并重新载入文件？')) return;
    state.configDirty = false;
    loadConfig(true);
  });
  document.getElementById('config-revert').addEventListener('click', revertConfig);
  document.getElementById('config-save').addEventListener('click', saveConfig);
  document.getElementById('send').addEventListener('click', dispatch);
  document.getElementById('prompt').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      dispatch();
    }
  });
  loadBoard();
  loadMetrics();
  loadConfig(false);
  loadAudit();
  setInterval(function () {
    if (!state.busy && !document.hidden) loadBoard();
  }, 5000);
  setInterval(function () {
    if (!state.busy && !document.hidden) loadMetrics();
  }, 60000);
  setInterval(function () {
    if (!state.busy && !document.hidden) loadAudit();
  }, 20000);
})();
</script>
</body>
</html>
`;
