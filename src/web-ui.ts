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
  input, select { background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; min-width: 0; }
  input[type=checkbox] { width: auto; border: 0; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  pre { margin: 0; padding: 8px; border: 1px solid var(--line); border-radius: 6px; overflow: auto; max-height: 360px; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0 0 12px; font-size: 13px; }
  dt { color: var(--muted); }
  dd { margin: 0; word-break: break-all; white-space: pre-wrap; }
  #detail { border-color: var(--accent); }
  #toast { position: fixed; right: 16px; bottom: 16px; max-width: 420px; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); box-shadow: 0 4px 16px rgba(0,0,0,.15); font-size: 13px; white-space: pre-wrap; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .chart { border: 1px solid var(--line); border-radius: 6px; padding: 8px; min-width: 0; }
  .chart-title { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .bars { display: flex; align-items: flex-end; gap: 3px; height: 120px; }
  .bar { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; }
  .bar-pair { display: flex; align-items: flex-end; gap: 1px; height: 100%; }
  .bar-fill { flex: 1; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 1px; }
  .bar-fill.alt { background: var(--muted); }
  .bar-label { font-size: 10px; color: var(--muted); text-align: center; white-space: nowrap; overflow: hidden; }
  .legend { display: flex; gap: 10px; font-size: 11px; color: var(--muted); margin-bottom: 6px; }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--accent); margin-right: 4px; }
  .legend i.alt { background: var(--muted); }
  .cfg-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--line); }
  .cfg-row input[type=text] { flex: 1 1 140px; }
  .field { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .field > label { width: 110px; flex: none; }
  .field > input, .field > select, .field > textarea { flex: 1; }
  details > summary { cursor: pointer; font-weight: 500; }
  #rewind-box { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 8px; }
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
    <h2>指标 <span id="stats-range" class="badge"></span>
      <div class="spacer"></div>
      <select id="stats-days"><option value="7">7 天</option><option value="14">14 天</option><option value="30">30 天</option></select>
    </h2>
    <div id="charts" class="charts"></div>
  </section>

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

  <section id="detail" hidden></section>

  <section>
    <details>
      <summary>配置 <span id="config-path" class="badge"></span></summary>
      <div class="row">
        <span class="muted">保存前校验，写入配置文件；重启守护进程后生效。</span>
        <div class="spacer"></div>
        <button id="config-reload">重新加载</button>
        <button id="config-save" class="primary">保存配置</button>
      </div>
      <div id="config-body"></div>
    </details>
  </section>

  <section>
    <details>
      <summary>审计日志 <span class="badge">最近 50 条写操作</span></summary>
      <table><thead><tr><th>时间</th><th>操作</th><th>对象</th><th>结果</th><th>身份</th><th>详情</th></tr></thead><tbody id="audit-rows"></tbody></table>
    </details>
  </section>
</main>
<div id="toast" hidden></div>

<script>
(function () {
  'use strict';
  var state = { repo: '', busy: false, detail: null, config: null, adapters: [], configPath: '' };
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ACTION_LABEL = { dispatch: '派活', cancel: '取消', merge: '合并', rewind: '撤销', 'config.save': '保存配置' };
  var token = new URLSearchParams(location.search).get('token');
  if (token) history.replaceState(null, '', location.pathname);

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
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
  function textCell(row, text, cls) {
    cell(row, el('span', cls, text), cls === 'num' ? 'num' : null);
  }
  function taskRow(task) {
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
    tasks.forEach(function (task) { body.appendChild(taskRow(task)); });
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
  function timeText(value) {
    return value ? new Date(value).toLocaleString() : '-';
  }
  function timeShort(value) {
    return value ? new Date(value).toLocaleTimeString().slice(0, 5) : '-';
  }
  function durationText(ms) {
    if (ms === null || ms === undefined) return '-';
    var sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm' + (sec % 60) + 's';
    return Math.floor(sec / 3600) + 'h' + Math.floor((sec % 3600) / 60) + 'm';
  }
  function chartBox(title) {
    var box = el('div', 'chart');
    box.appendChild(el('div', 'chart-title', title));
    return box;
  }
  function chartLegend(series) {
    var row = el('div', 'legend');
    series.forEach(function (s) {
      var item = el('span');
      item.appendChild(el('i', s.alt ? 'alt' : null));
      item.appendChild(document.createTextNode(s.label));
      row.appendChild(item);
    });
    return row;
  }
  function barsChart(title, buckets, series, maxOverride) {
    var box = chartBox(title);
    var max = maxOverride || 0;
    if (!maxOverride) {
      buckets.forEach(function (bucket) {
        series.forEach(function (s) {
          var value = bucket[s.key];
          if (value !== null && value !== undefined && value > max) max = value;
        });
      });
    }
    if (max <= 0) {
      box.appendChild(el('div', 'muted', '（没有样本）'));
      return box;
    }
    if (series.length > 1) box.appendChild(chartLegend(series));
    var bars = el('div', 'bars');
    buckets.forEach(function (bucket) {
      var column = el('div', 'bar');
      var pair = el('div', 'bar-pair');
      series.forEach(function (s) {
        var fill = el('div', 'bar-fill' + (s.alt ? ' alt' : ''));
        var value = bucket[s.key];
        fill.style.height = value === null || value === undefined ? '0%' : Math.max(1, Math.round((value / max) * 100)) + '%';
        fill.title = bucket.label + ' ' + s.label + ' ' + s.format(value);
        pair.appendChild(fill);
      });
      column.appendChild(pair);
      column.appendChild(el('div', 'bar-label', bucket.label));
      bars.appendChild(column);
    });
    box.appendChild(bars);
    return box;
  }
  function queueChart(points) {
    var box = chartBox('队列深度（每小时采样）');
    if (!points.length) {
      box.appendChild(el('div', 'muted', '（没有样本）'));
      return box;
    }
    var max = 0;
    points.forEach(function (point) { if (point.depth > max) max = point.depth; });
    var top = max || 1;
    var W = 600, H = 120, padX = 4, padY = 8;
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: '120' });
    var coords = points.map(function (point, index) {
      var x = padX + (points.length === 1 ? 0 : index * (W - padX * 2) / (points.length - 1));
      var y = H - padY - (point.depth / top) * (H - padY * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    if (points.length > 1) {
      var poly = svgEl('polyline', { points: coords.join(' '), fill: 'none', 'stroke-width': '1.5' });
      poly.setAttribute('style', 'stroke: var(--accent)');
      svg.appendChild(poly);
    } else {
      var parts = coords[0].split(',');
      var dot = svgEl('circle', { cx: parts[0], cy: parts[1], r: '2.5' });
      dot.setAttribute('style', 'fill: var(--accent)');
      svg.appendChild(dot);
    }
    var title = svgEl('title', {});
    title.textContent = '峰值 ' + max;
    svg.appendChild(title);
    box.appendChild(svg);
    box.appendChild(el('div', 'muted', timeShort(points[0].at) + ' → ' + timeShort(points[points.length - 1].at) + ' · 峰值 ' + max));
    return box;
  }
  function renderStats(data) {
    var box = document.getElementById('charts');
    box.textContent = '';
    var finished = 0, succeeded = 0, peak = 0;
    data.buckets.forEach(function (bucket) {
      finished += bucket.finished;
      succeeded += bucket.succeeded;
    });
    data.queue.forEach(function (point) { if (point.depth > peak) peak = point.depth; });
    document.getElementById('stats-range').textContent = '最近 ' + data.days + ' 天 · 完成 ' + finished +
      ' · 成功率 ' + (finished ? Math.round((succeeded / finished) * 100) + '%' : '-') + ' · 队列峰值 ' + peak;
    box.appendChild(barsChart('成功率', data.buckets, [{
      key: 'successRate', label: '成功率',
      format: function (value) { return value === null || value === undefined ? '-' : Math.round(value * 100) + '%'; }
    }], 1));
    box.appendChild(barsChart('耗时 P50 / P95', data.buckets, [
      { key: 'p50Ms', label: 'P50', format: durationText },
      { key: 'p95Ms', label: 'P95', alt: true, format: durationText }
    ]));
    box.appendChild(queueChart(data.queue));
  }
  async function loadStats() {
    try {
      var days = document.getElementById('stats-days').value || '7';
      renderStats(await api('/api/stats?days=' + encodeURIComponent(days)));
    } catch (err) {
      document.getElementById('stats-range').textContent = '加载失败：' + err.message;
    }
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
    rewind.disabled = !['succeeded', 'failed', 'cancelled'].includes(data.task.status);
    rewind.addEventListener('click', function () { loadRewindPreview(data.task.id); });
    actions.appendChild(cancel);
    actions.appendChild(merge);
    actions.appendChild(rewind);
    box.appendChild(actions);

    var rewindBox = el('div');
    rewindBox.id = 'rewind-box';
    rewindBox.hidden = true;
    box.appendChild(rewindBox);

    box.appendChild(el('h2', null, 'Prompt'));
    var prompt = el('pre', null, data.task.prompt);
    box.appendChild(prompt);
    box.appendChild(el('h2', null, '日志尾部（最后 ' + data.logTail.length + ' 行）'));
    box.appendChild(el('pre', null, data.logTail.length ? data.logTail.join('\\n') : '（还没有日志）'));
  }
  async function loadRewindPreview(id) {
    try {
      renderRewindPreview((await api('/api/tasks/' + encodeURIComponent(id) + '/rewind')).preview);
    } catch (err) {
      toast(err.message, true);
    }
  }
  function renderRewindPreview(preview) {
    var box = document.getElementById('rewind-box');
    if (!box) return;
    box.textContent = '';
    box.hidden = false;
    box.appendChild(el('h3', null, '撤销预览'));
    var dl = el('dl');
    detailRow(dl, '合并', preview.mergeLabel);
    detailRow(dl, '将执行', preview.actions.length ? preview.actions.map(function (action, index) { return (index + 1) + '. ' + action.label; }).join('\\n') : '没有需要执行的动作');
    if (preview.irreversible.length) detailRow(dl, '不可撤销', preview.irreversible.join('\\n'));
    if (preview.notes.length) detailRow(dl, '保留', preview.notes.join('\\n'));
    box.appendChild(dl);
    if (!preview.executable) box.appendChild(el('div', 'muted', '无法确认合并状态，撤销不会执行。'));
    var run = el('button', 'danger', '执行撤销');
    run.disabled = !preview.executable;
    run.addEventListener('click', function () {
      var lines = ['撤销 ' + preview.taskId + '？', '合并：' + preview.mergeLabel];
      if (preview.actions.length) lines.push('将执行：', preview.actions.map(function (action) { return '- ' + action.label; }).join('\\n'));
      if (preview.irreversible.length) lines.push('不可撤销：', preview.irreversible.join('\\n'));
      if (!confirm(lines.join('\\n'))) return;
      writeAction('/api/tasks/' + preview.taskId + '/rewind', { confirm: true }, '已撤销 ' + preview.taskId);
    });
    box.appendChild(run);
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
      await loadAudit();
      await loadStats();
      if (state.detail) await openDetail(state.detail.id);
    }
  }
  async function dispatch() {
    var area = document.getElementById('prompt');
    var text = area.value.trim();
    var msg = document.getElementById('dispatch-msg');
    if (!text) { msg.textContent = '任务内容不能为空'; msg.className = 'bad'; return; }
    if (!confirm('派活到 ' + (state.repo || '默认仓库') + '？\\n\\n' + (text.length > 200 ? text.slice(0, 200) + '…' : text))) return;
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
      await loadStats();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'bad';
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  }

  function textInput(value, onInput, type) {
    var node = el('input');
    node.type = type || 'text';
    node.value = value === null || value === undefined ? '' : String(value);
    node.addEventListener('input', function () { onInput(node.value); });
    return node;
  }
  function checkbox(checked, onChange) {
    var node = el('input');
    node.type = 'checkbox';
    node.checked = checked === true;
    node.addEventListener('change', function () { onChange(node.checked); });
    return node;
  }
  function field(parent, label, node) {
    var row = el('div', 'field');
    row.appendChild(el('label', 'muted', label));
    row.appendChild(node);
    parent.appendChild(row);
    return node;
  }
  function repoRow(repo) {
    var row = el('div', 'cfg-row');
    var alias = textInput(repo.alias, function (value) { repo.alias = value; });
    alias.placeholder = '别名';
    alias.title = '别名：字母、数字、下划线、连字符';
    var path = textInput(repo.path, function (value) { repo.path = value; });
    path.placeholder = '路径（相对配置文件或绝对路径）';
    var base = textInput(repo.baseBranch, function (value) { repo.baseBranch = value; });
    base.placeholder = '主干（默认 main）';
    var remote = textInput(repo.remote, function (value) { repo.remote = value; });
    remote.placeholder = '远程名（可选）';
    var allowLabel = el('label', 'muted');
    allowLabel.appendChild(checkbox(repo.allowed, function (value) { repo.allowed = value; }));
    allowLabel.appendChild(document.createTextNode(' 允许派活'));
    var remove = el('button', 'danger', '删除');
    remove.addEventListener('click', function () {
      var index = state.config.repos.indexOf(repo);
      if (index >= 0) state.config.repos.splice(index, 1);
      renderConfigBody();
    });
    row.appendChild(alias);
    row.appendChild(path);
    row.appendChild(base);
    row.appendChild(remote);
    row.appendChild(allowLabel);
    row.appendChild(remove);
    return row;
  }
  function scheduleRow(job) {
    var row = el('div', 'cfg-row');
    var id = textInput(job.id, function (value) { job.id = value; });
    id.placeholder = 'id';
    var cron = textInput(job.cron, function (value) { job.cron = value; });
    cron.placeholder = 'cron（5 段）';
    var prompt = textInput(job.prompt, function (value) { job.prompt = value; });
    prompt.placeholder = '任务内容';
    var repo = el('select');
    var blank = el('option', null, '（默认仓库）');
    blank.value = '';
    repo.appendChild(blank);
    state.config.repos.forEach(function (candidate) {
      var option = el('option', null, candidate.alias || '（未命名）');
      option.value = candidate.alias;
      repo.appendChild(option);
    });
    repo.value = job.repo || '';
    repo.addEventListener('change', function () { job.repo = repo.value || undefined; });
    var enabledLabel = el('label', 'muted');
    enabledLabel.appendChild(checkbox(job.enabled !== false, function (value) { job.enabled = value; }));
    enabledLabel.appendChild(document.createTextNode(' 启用'));
    var remove = el('button', 'danger', '删除');
    remove.addEventListener('click', function () {
      var index = state.config.schedules.indexOf(job);
      if (index >= 0) state.config.schedules.splice(index, 1);
      renderConfigBody();
    });
    row.appendChild(id);
    row.appendChild(cron);
    row.appendChild(prompt);
    row.appendChild(repo);
    row.appendChild(enabledLabel);
    row.appendChild(remove);
    return row;
  }
  function renderConfigBody() {
    var body = document.getElementById('config-body');
    body.textContent = '';

    body.appendChild(el('h3', null, '仓库'));
    if (!state.config.repos.length) body.appendChild(el('div', 'muted', '（还没有仓库）'));
    state.config.repos.forEach(function (repo) { body.appendChild(repoRow(repo)); });
    var addRepo = el('button', null, '添加仓库');
    addRepo.addEventListener('click', function () {
      state.config.repos.push({ alias: '', path: '', baseBranch: 'main', remote: '', allowed: true });
      renderConfigBody();
    });
    body.appendChild(el('div', 'row')).appendChild(addRepo);

    var worker = state.config.worker;
    body.appendChild(el('h3', null, 'Worker'));
    var adapter = el('select');
    (state.adapters.length ? state.adapters : [worker.adapter]).forEach(function (name) {
      var option = el('option', null, name);
      option.value = name;
      adapter.appendChild(option);
    });
    adapter.value = worker.adapter;
    adapter.addEventListener('change', function () { worker.adapter = adapter.value; });
    field(body, '适配器', adapter);
    field(body, '命令', textInput(worker.command, function (value) { worker.command = value; }));
    var concurrency = field(body, '并发', textInput(worker.concurrency, function (value) { worker.concurrency = value === '' ? null : Number(value); }, 'number'));
    concurrency.min = '1';
    concurrency.max = '32';
    var timeout = field(body, '超时（秒）', textInput(worker.timeoutSec, function (value) { worker.timeoutSec = value === '' ? null : Number(value); }, 'number'));
    timeout.min = '1';
    timeout.step = '1';
    var extra = el('textarea');
    extra.value = (worker.extraArgs || []).join('\\n');
    extra.addEventListener('input', function () {
      worker.extraArgs = extra.value.split('\\n').map(function (line) { return line.trim(); }).filter(Boolean);
    });
    field(body, '额外参数', extra);

    body.appendChild(el('h3', null, '定时任务'));
    if (!state.config.schedules.length) body.appendChild(el('div', 'muted', '（还没有定时任务）'));
    state.config.schedules.forEach(function (job) { body.appendChild(scheduleRow(job)); });
    var addJob = el('button', null, '添加定时任务');
    addJob.addEventListener('click', function () {
      state.config.schedules.push({ id: '', cron: '', prompt: '', repo: '', enabled: true });
      renderConfigBody();
    });
    body.appendChild(el('div', 'row')).appendChild(addJob);
  }
  async function loadConfig() {
    try {
      var data = await api('/api/config');
      state.config = data.config;
      state.adapters = data.adapters || [];
      state.configPath = data.configPath || '';
      document.getElementById('config-path').textContent = state.configPath;
      renderConfigBody();
    } catch (err) {
      toast('配置加载失败：' + err.message, true);
    }
  }
  async function saveConfig() {
    if (!state.config) return;
    if (!confirm('保存配置到 ' + (state.configPath || '配置文件') + '？\\n\\n保存后需要重启守护进程才会生效。')) return;
    var button = document.getElementById('config-save');
    button.disabled = true;
    try {
      var res = await api('/api/config', { method: 'POST', body: JSON.stringify({ confirm: true, config: state.config }) });
      toast(res.message || '已保存');
      await loadConfig();
      await loadAudit();
      await loadStats();
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  }
  async function loadAudit() {
    try {
      var data = await api('/api/audit?limit=50');
      var body = document.getElementById('audit-rows');
      body.textContent = '';
      if (!data.entries.length) {
        var row = el('tr');
        var cellNode = el('td', 'muted', '（暂无记录）');
        cellNode.colSpan = 6;
        row.appendChild(cellNode);
        body.appendChild(row);
        return;
      }
      data.entries.forEach(function (entry) {
        var row = el('tr');
        textCell(row, timeText(entry.at));
        textCell(row, ACTION_LABEL[entry.action] || entry.action);
        textCell(row, entry.target || '-');
        textCell(row, entry.ok ? '成功' : '失败', entry.ok ? 'ok' : 'bad');
        textCell(row, entry.actor || '-');
        textCell(row, entry.detail || '-');
        body.appendChild(row);
      });
    } catch (err) {
      toast('审计日志加载失败：' + err.message, true);
    }
  }

  document.getElementById('refresh').addEventListener('click', function () {
    loadBoard();
    loadStats();
    loadAudit();
  });
  document.getElementById('repo').addEventListener('change', function (event) {
    state.repo = event.target.value;
    loadBoard();
  });
  document.getElementById('stats-days').addEventListener('change', loadStats);
  document.getElementById('send').addEventListener('click', dispatch);
  document.getElementById('config-save').addEventListener('click', saveConfig);
  document.getElementById('config-reload').addEventListener('click', loadConfig);
  document.getElementById('prompt').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      dispatch();
    }
  });
  loadBoard();
  loadStats();
  loadConfig();
  loadAudit();
  setInterval(function () {
    if (!state.busy && !document.hidden) loadBoard();
  }, 5000);
})();
</script>
</body>
</html>
`;
