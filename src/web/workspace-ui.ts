export function renderWorkspacePage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>InternFlow · Engineering Memory</title>
  <style>
    :root {
      --bg: #f2f5f4;
      --surface: #ffffff;
      --surface-muted: #e8eeec;
      --ink: #17211f;
      --muted: #64716e;
      --line: #cdd8d5;
      --accent: #087f72;
      --accent-dark: #075f56;
      --warn: #9a6500;
      --danger: #a33a3a;
      --header: #182321;
      --header-ink: #eef6f3;
      --radius: 6px;
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      color: var(--ink);
      background: var(--bg);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      letter-spacing: 0;
    }
    button, select { font: inherit; }
    button:focus-visible, select:focus-visible, a:focus-visible {
      outline: 2px solid #19a99a;
      outline-offset: 2px;
    }

    .header {
      min-height: 64px;
      color: var(--header-ink);
      background: var(--header);
      border-bottom: 3px solid var(--accent);
    }
    .header-inner {
      width: min(1400px, calc(100% - 32px));
      min-height: 64px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    .brand { min-width: 0; }
    .brand strong { display: block; font-size: 17px; font-weight: 700; }
    .brand span { display: block; margin-top: 2px; color: #a9bbb6; font-size: 12px; }
    .back {
      color: var(--header-ink);
      text-decoration: none;
      border: 1px solid #4b5e59;
      border-radius: var(--radius);
      padding: 7px 10px;
      white-space: nowrap;
    }
    .back:hover { border-color: #8aa49d; background: #24312e; }

    .toolbar {
      min-height: 58px;
      background: var(--surface);
      border-bottom: 1px solid var(--line);
    }
    .toolbar-inner {
      width: min(1400px, calc(100% - 32px));
      min-height: 58px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .workspace-picker {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }
    .workspace-picker label { color: var(--muted); font-size: 12px; }
    .workspace-picker select {
      min-width: 220px;
      max-width: 420px;
      height: 34px;
      color: var(--ink);
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 0 30px 0 9px;
    }
    .sync-meta { color: var(--muted); font-size: 12px; text-align: right; }

    .filters {
      width: min(1400px, calc(100% - 32px));
      margin: 14px auto 0;
      display: flex;
      gap: 4px;
      overflow-x: auto;
    }
    .filter {
      height: 34px;
      flex: 0 0 auto;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-bottom: 2px solid transparent;
      padding: 0 12px;
      cursor: pointer;
    }
    .filter:hover { color: var(--ink); }
    .filter.active { color: var(--accent-dark); border-bottom-color: var(--accent); font-weight: 700; }

    .layout {
      width: min(1400px, calc(100% - 32px));
      height: calc(100vh - 170px);
      min-height: 520px;
      margin: 0 auto 24px;
      display: grid;
      grid-template-columns: minmax(260px, 330px) minmax(0, 1fr);
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .subjects {
      min-width: 0;
      border-right: 1px solid var(--line);
      background: #f8faf9;
      overflow-y: auto;
    }
    .subject-button {
      width: 100%;
      min-height: 78px;
      display: block;
      text-align: left;
      color: inherit;
      background: transparent;
      border: 0;
      border-bottom: 1px solid var(--line);
      padding: 12px 14px;
      cursor: pointer;
    }
    .subject-button:hover { background: var(--surface-muted); }
    .subject-button.active {
      background: var(--surface);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .subject-title {
      display: block;
      font-weight: 700;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .subject-meta {
      margin-top: 7px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      height: 22px;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 0 6px;
      color: var(--muted);
      background: var(--surface);
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .status.completed { color: var(--accent-dark); border-color: #83bdb5; background: #edf8f6; }
    .status.blocked { color: var(--danger); border-color: #d8a0a0; background: #fff3f3; }
    .status.in_progress { color: var(--warn); border-color: #d5ba7e; background: #fff9e9; }

    .detail {
      min-width: 0;
      overflow-y: auto;
      background: var(--surface);
    }
    .detail-head {
      padding: 22px 26px 18px;
      border-bottom: 1px solid var(--line);
    }
    .detail-head h1 {
      margin: 0;
      font-size: 23px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .detail-head .meta {
      margin-top: 10px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 14px;
      color: var(--muted);
      font-size: 12px;
    }
    .summary {
      padding: 20px 26px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 20px 28px;
      border-bottom: 1px solid var(--line);
    }
    .summary section { min-width: 0; }
    .summary h2, .timeline-head h2 {
      margin: 0 0 8px;
      font-size: 13px;
      text-transform: uppercase;
      color: var(--muted);
    }
    .summary p { margin: 0; line-height: 1.65; overflow-wrap: anywhere; }
    .plain-list { margin: 0; padding-left: 18px; line-height: 1.65; }
    .plain-list li + li { margin-top: 3px; }
    .empty-inline { color: var(--muted); }

    .timeline { padding: 20px 26px 36px; }
    .timeline-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 8px;
    }
    .timeline-count { color: var(--muted); font-size: 12px; }
    .entry {
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr);
      gap: 18px;
      padding: 18px 0;
      border-top: 1px solid var(--line);
    }
    .entry-date { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .entry h3 { margin: 0; font-size: 15px; line-height: 1.4; overflow-wrap: anywhere; }
    .entry-goal { margin: 7px 0 0; color: #34413e; line-height: 1.6; overflow-wrap: anywhere; }
    .entry-grid {
      margin-top: 12px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px 24px;
    }
    .entry-grid h4 { margin: 0 0 5px; color: var(--muted); font-size: 11px; text-transform: uppercase; }
    .entry-grid ul { margin: 0; padding-left: 17px; line-height: 1.55; }
    .match { margin-top: 10px; color: var(--muted); font-size: 11px; }

    .empty {
      min-height: 260px;
      display: grid;
      place-items: center;
      padding: 32px;
      color: var(--muted);
      text-align: center;
      line-height: 1.6;
    }

    @media (max-width: 760px) {
      .header-inner, .toolbar-inner, .filters, .layout { width: min(100% - 20px, 100%); }
      .toolbar-inner { align-items: flex-start; flex-direction: column; justify-content: center; padding: 10px 0; }
      .workspace-picker { width: 100%; }
      .workspace-picker select { flex: 1; min-width: 0; max-width: none; }
      .sync-meta { text-align: left; }
      .layout {
        height: auto;
        min-height: 0;
        grid-template-columns: 1fr;
        overflow: visible;
      }
      .subjects { max-height: 270px; border-right: 0; border-bottom: 1px solid var(--line); }
      .detail { overflow: visible; }
      .summary, .entry-grid { grid-template-columns: 1fr; }
      .detail-head, .summary, .timeline { padding-left: 16px; padding-right: 16px; }
      .entry { grid-template-columns: 1fr; gap: 6px; }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-inner">
      <div class="brand">
        <strong>InternFlow Engineering Memory</strong>
        <span>长期工作主题与变更时间线</span>
      </div>
      <a class="back" href="/">日报控制台</a>
    </div>
  </header>

  <section class="toolbar">
    <div class="toolbar-inner">
      <div class="workspace-picker">
        <label for="workspace">Workspace</label>
        <select id="workspace" aria-label="选择 Workspace"></select>
      </div>
      <div class="sync-meta" id="sync-meta">正在读取...</div>
    </div>
  </section>

  <nav class="filters" aria-label="主题状态">
    <button class="filter active" type="button" data-status="all">全部</button>
    <button class="filter" type="button" data-status="in_progress">进行中</button>
    <button class="filter" type="button" data-status="completed">已完成</button>
    <button class="filter" type="button" data-status="blocked">阻塞</button>
    <button class="filter" type="button" data-status="investigated">已调研</button>
  </nav>

  <main class="layout">
    <aside class="subjects" id="subjects"><div class="empty">正在加载主题...</div></aside>
    <article class="detail" id="detail"><div class="empty">选择一个主题查看详情</div></article>
  </main>

  <script>
    const state = { workspaces: [], workspaceIndex: 0, status: 'all', subjectId: null };
    const subjectsEl = document.getElementById('subjects');
    const detailEl = document.getElementById('detail');
    const pickerEl = document.getElementById('workspace');
    const syncMetaEl = document.getElementById('sync-meta');

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function statusLabel(value) {
      return {
        completed: '已完成',
        in_progress: '进行中',
        blocked: '阻塞',
        investigated: '已调研'
      }[value] || value;
    }

    function list(values, emptyText) {
      if (!Array.isArray(values) || !values.length) {
        return '<span class="empty-inline">' + escapeHtml(emptyText) + '</span>';
      }
      return '<ul class="plain-list">' + values.map(function (value) {
        return '<li>' + escapeHtml(value) + '</li>';
      }).join('') + '</ul>';
    }

    function activeWorkspace() {
      return state.workspaces[state.workspaceIndex] || null;
    }

    function filteredSubjects() {
      const workspace = activeWorkspace();
      if (!workspace) return [];
      return workspace.state.subjects.filter(function (subject) {
        return state.status === 'all' || subject.status === state.status;
      });
    }

    function renderSubjects() {
      const subjects = filteredSubjects();
      if (!subjects.length) {
        subjectsEl.innerHTML = '<div class="empty">当前筛选下没有主题</div>';
        state.subjectId = null;
        renderDetail();
        return;
      }
      if (!subjects.some(function (subject) { return subject.id === state.subjectId; })) {
        state.subjectId = subjects[0].id;
      }
      subjectsEl.innerHTML = subjects.map(function (subject) {
        const active = subject.id === state.subjectId ? ' active' : '';
        return '<button class="subject-button' + active + '" type="button" data-subject="' + escapeHtml(subject.id) + '">'
          + '<span class="subject-title">' + escapeHtml(subject.title) + '</span>'
          + '<span class="subject-meta"><span class="status ' + escapeHtml(subject.status) + '">'
          + escapeHtml(statusLabel(subject.status)) + '</span><span>' + escapeHtml(subject.lastSeenAt) + '</span></span>'
          + '</button>';
      }).join('');
      subjectsEl.querySelectorAll('[data-subject]').forEach(function (button) {
        button.addEventListener('click', function () {
          state.subjectId = button.dataset.subject;
          renderSubjects();
          renderDetail();
        });
      });
      renderDetail();
    }

    function renderEntry(entry) {
      const verifications = (entry.verifications || []).map(function (item) {
        return item.command + ': ' + item.outcome;
      });
      return '<section class="entry">'
        + '<div class="entry-date">' + escapeHtml(entry.date) + '</div>'
        + '<div><h3>' + escapeHtml(entry.title) + '</h3>'
        + '<p class="entry-goal">' + escapeHtml(entry.goal) + '</p>'
        + '<div class="entry-grid">'
        + '<section><h4>推进</h4>' + list(entry.actions, '无新增动作') + '</section>'
        + '<section><h4>结果</h4>' + list(entry.outcomes, '暂无结果') + '</section>'
        + '<section><h4>决策</h4>' + list(entry.decisions, '无新增决策') + '</section>'
        + '<section><h4>验证</h4>' + list(verifications, '暂无验证') + '</section>'
        + '</div>'
        + '<div class="match">关联方式：' + escapeHtml(entry.match.method)
        + ' · score ' + escapeHtml(entry.match.score) + ' · evidence ' + escapeHtml(entry.evidenceIds.length) + '</div>'
        + '</div></section>';
    }

    function renderDetail() {
      const workspace = activeWorkspace();
      const subject = workspace && workspace.state.subjects.find(function (item) {
        return item.id === state.subjectId;
      });
      if (!workspace || !subject) {
        detailEl.innerHTML = '<div class="empty">选择一个主题查看详情</div>';
        return;
      }
      const entries = workspace.state.entries
        .filter(function (entry) { return entry.subjectId === subject.id; })
        .sort(function (left, right) {
          return right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt);
        });
      detailEl.innerHTML = '<header class="detail-head">'
        + '<h1>' + escapeHtml(subject.title) + '</h1>'
        + '<div class="meta"><span class="status ' + escapeHtml(subject.status) + '">'
        + escapeHtml(statusLabel(subject.status)) + '</span>'
        + '<span>' + escapeHtml(subject.repositoryKey) + '</span>'
        + '<span>' + escapeHtml(subject.firstSeenAt) + ' 至 ' + escapeHtml(subject.lastSeenAt) + '</span>'
        + '</div></header>'
        + '<section class="summary">'
        + '<section><h2>当前目标</h2><p>' + escapeHtml(subject.current.goal || '暂无目标') + '</p></section>'
        + '<section><h2>最新验证</h2><p>' + escapeHtml(subject.current.latestVerification || '暂无验证') + '</p></section>'
        + '<section><h2>当前结果</h2>' + list(subject.current.outcomes, '暂无结果') + '</section>'
        + '<section><h2>阻塞</h2>' + list(subject.current.blockers, '当前无阻塞') + '</section>'
        + '</section>'
        + '<section class="timeline"><div class="timeline-head"><h2>变更时间线</h2>'
        + '<span class="timeline-count">' + entries.length + ' entries</span></div>'
        + entries.map(renderEntry).join('') + '</section>';
    }

    function renderWorkspace() {
      const workspace = activeWorkspace();
      if (!workspace) {
        pickerEl.innerHTML = '<option>未配置 Workspace</option>';
        pickerEl.disabled = true;
        syncMetaEl.textContent = '使用 internflow job add workspace 创建';
        subjectsEl.innerHTML = '<div class="empty">还没有配置 Engineering Memory</div>';
        detailEl.innerHTML = '<div class="empty">暂无可查看的数据</div>';
        return;
      }
      pickerEl.disabled = false;
      pickerEl.innerHTML = state.workspaces.map(function (item, index) {
        return '<option value="' + index + '"' + (index === state.workspaceIndex ? ' selected' : '') + '>'
          + escapeHtml(item.jobName) + '</option>';
      }).join('');
      const updated = workspace.state.updatedAt
        ? new Date(workspace.state.updatedAt).toLocaleString()
        : '尚未同步';
      syncMetaEl.textContent = (workspace.enabled ? '已启用' : '已停用') + ' · '
        + workspace.schedule + ' · revision ' + workspace.state.revision + ' · ' + updated;
      renderSubjects();
    }

    async function apiFetch() {
      const headers = {};
      const token = sessionStorage.getItem('internflow-web-token');
      if (token) headers.authorization = 'Bearer ' + token;
      let response = await fetch('/api/workspaces', { headers: headers });
      if (response.status === 401) {
        const entered = window.prompt('请输入 InternFlow Web 访问令牌');
        if (!entered) throw new Error('未提供访问令牌');
        sessionStorage.setItem('internflow-web-token', entered);
        response = await fetch('/api/workspaces', { headers: { authorization: 'Bearer ' + entered } });
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Workspace 请求失败');
      return body;
    }

    pickerEl.addEventListener('change', function () {
      state.workspaceIndex = Number(pickerEl.value) || 0;
      state.subjectId = null;
      renderWorkspace();
    });
    document.querySelectorAll('[data-status]').forEach(function (button) {
      button.addEventListener('click', function () {
        state.status = button.dataset.status;
        state.subjectId = null;
        document.querySelectorAll('[data-status]').forEach(function (item) {
          item.classList.toggle('active', item === button);
        });
        renderSubjects();
      });
    });

    apiFetch().then(function (result) {
      state.workspaces = result.workspaces || [];
      renderWorkspace();
    }).catch(function (error) {
      syncMetaEl.textContent = String(error);
      subjectsEl.innerHTML = '<div class="empty">Workspace 数据读取失败</div>';
      detailEl.innerHTML = '<div class="empty">' + escapeHtml(String(error)) + '</div>';
    });
  </script>
</body>
</html>`;
}
