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
      ' · 运行 ' + data.counts.running + ' / 排队 ' + data.counts.queued + ' / 中断 ' + data.counts.paused +
      ' · 槽位 worker ' + data.slots.running.worker + '/' + data.slots.limits.worker +
      ' · 追问 ' + data.slots.running.human + '/' + data.slots.limits.human;
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
      var body = { prompt: text };
      if (state.repo) body.repo = state.repo;
      var res = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
      area.value = '';
      msg.textContent = '已接单 · ' + (res.taskId || '');
      msg.className = 'ok';
      await loadBoard();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'bad';
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  }
  document.getElementById('refresh').addEventListener('click', loadBoard);
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
  loadBoard();
  setInterval(function () {
    if (!state.busy && !document.hidden) loadBoard();
  }, 5000);
})();
</script>
</body>
</html>
`;
