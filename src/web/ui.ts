export function renderUiPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>InternFlow · Codex 日报试用</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&family=Literata:opsz,wght@7..72,500;7..72,600&display=swap" rel="stylesheet" />
  <style>
    :root {
      --void: #071018;
      --panel: #0d1a24;
      --panel-2: #122433;
      --line: rgba(120, 168, 196, 0.18);
      --ink: #e7f2f8;
      --muted: #8aa8b8;
      --faint: #5f7f90;
      --signal: #3ecfbf;
      --signal-dim: rgba(62, 207, 191, 0.14);
      --warn: #f0b45a;
      --danger: #ff7b72;
      --paper: #f4efe4;
      --paper-ink: #1a2430;
      --shadow: 0 28px 80px rgba(0, 0, 0, 0.45);
      --radius: 18px;
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      font-family: "DM Sans", system-ui, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(1200px 600px at 10% -10%, rgba(62, 207, 191, 0.12), transparent 55%),
        radial-gradient(900px 500px at 100% 0%, rgba(240, 180, 90, 0.08), transparent 50%),
        linear-gradient(180deg, #08131b 0%, var(--void) 45%, #050b10 100%);
      min-height: 100vh;
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(140, 190, 210, 0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(140, 190, 210, 0.035) 1px, transparent 1px);
      background-size: 48px 48px;
      mask-image: radial-gradient(ellipse at center, black 20%, transparent 75%);
      opacity: 0.7;
    }

    .shell {
      position: relative;
      width: min(980px, calc(100% - 32px));
      margin: 0 auto;
      padding: 40px 0 72px;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 28px;
    }

    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .workspace-link {
      color: var(--ink);
      text-decoration: none;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 12px;
    }

    .workspace-link:hover { border-color: var(--signal); }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .mark {
      width: 38px;
      height: 38px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      background: linear-gradient(145deg, rgba(62, 207, 191, 0.25), rgba(62, 207, 191, 0.05));
      border: 1px solid rgba(62, 207, 191, 0.35);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03);
      font-family: "JetBrains Mono", monospace;
      font-size: 13px;
      font-weight: 500;
      color: var(--signal);
    }

    .brand h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }

    .brand p {
      margin: 2px 0 0;
      color: var(--muted);
      font-size: 13px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(13, 26, 36, 0.85);
      color: var(--muted);
      font-size: 12px;
      font-family: "JetBrains Mono", monospace;
    }

    .pill .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--signal);
      box-shadow: 0 0 0 4px var(--signal-dim);
    }

    .hero {
      border: 1px solid var(--line);
      background:
        linear-gradient(180deg, rgba(18, 36, 51, 0.95), rgba(13, 26, 36, 0.92));
      border-radius: calc(var(--radius) + 4px);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .hero-main {
      padding: 28px 28px 22px;
      display: grid;
      grid-template-columns: 1.35fr 0.9fr;
      gap: 24px;
    }

    @media (max-width: 820px) {
      .hero-main { grid-template-columns: 1fr; }
    }

    .eyebrow {
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--signal);
      margin: 0 0 10px;
    }

    .hero h2 {
      margin: 0;
      font-size: clamp(28px, 4vw, 38px);
      line-height: 1.12;
      letter-spacing: -0.035em;
      font-weight: 700;
    }

    .hero .lead {
      margin: 12px 0 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.55;
      max-width: 42ch;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-top: 22px;
    }

    .stat {
      border: 1px solid var(--line);
      background: rgba(7, 16, 24, 0.45);
      border-radius: 14px;
      padding: 12px 14px;
    }

    .stat .label {
      color: var(--faint);
      font-size: 11px;
      font-family: "JetBrains Mono", monospace;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .stat .value {
      margin-top: 6px;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.03em;
    }

    .stat .hint {
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
    }

    .panel-side {
      border: 1px solid var(--line);
      border-radius: 16px;
      background:
        radial-gradient(280px 140px at 80% 0%, rgba(62, 207, 191, 0.12), transparent 60%),
        rgba(7, 16, 24, 0.55);
      padding: 18px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 100%;
    }

    .panel-side h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }

    .panel-side p {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 16px;
      font-size: 12px;
      color: var(--muted);
    }

    .field input {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(7, 16, 24, 0.55);
      color: var(--ink);
      padding: 10px 12px;
      font: inherit;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
    }

    .field input:focus {
      outline: 2px solid rgba(62, 207, 191, 0.35);
      outline-offset: 1px;
    }

    .actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 14px;
    }

    button {
      font: inherit;
      cursor: pointer;
      border: 0;
    }

    .btn-primary {
      position: relative;
      overflow: hidden;
      border-radius: 14px;
      padding: 14px 16px;
      color: #04201c;
      font-weight: 700;
      letter-spacing: -0.01em;
      background: linear-gradient(180deg, #63e7d7 0%, #2fbfae 100%);
      box-shadow:
        0 1px 0 rgba(255,255,255,0.35) inset,
        0 12px 28px rgba(46, 180, 164, 0.28);
      transition: transform 0.15s ease, filter 0.15s ease, box-shadow 0.15s ease;
    }

    .btn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      filter: brightness(1.03);
    }

    .btn-primary:disabled {
      cursor: wait;
      filter: saturate(0.75) brightness(0.95);
    }

    .btn-secondary {
      border-radius: 14px;
      padding: 12px 16px;
      color: var(--ink);
      background: transparent;
      border: 1px solid var(--line);
      font-weight: 500;
    }

    .btn-secondary:hover { background: rgba(255,255,255,0.03); }

    .hero-foot {
      border-top: 1px solid var(--line);
      padding: 14px 28px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px 18px;
      color: var(--faint);
      font-size: 12px;
      font-family: "JetBrains Mono", monospace;
      background: rgba(0,0,0,0.18);
    }

    .sessions {
      margin-top: 22px;
    }

    .section-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin: 0 0 12px;
    }

    .section-title h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
    }

    .section-title span {
      color: var(--faint);
      font-size: 12px;
      font-family: "JetBrains Mono", monospace;
    }

    .session-list {
      display: grid;
      gap: 10px;
    }

    .session {
      border: 1px solid var(--line);
      background: rgba(13, 26, 36, 0.72);
      border-radius: 14px;
      padding: 14px 16px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px 16px;
    }

    .session .title {
      font-weight: 600;
      font-size: 14px;
    }

    .session .meta {
      grid-column: 1 / -1;
      color: var(--muted);
      font-size: 12px;
      font-family: "JetBrains Mono", monospace;
      line-height: 1.55;
      word-break: break-all;
    }

    .session .chip {
      justify-self: end;
      align-self: start;
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--signal-dim);
      color: var(--signal);
      font-size: 11px;
      font-family: "JetBrains Mono", monospace;
    }

    .empty {
      border: 1px dashed var(--line);
      border-radius: 14px;
      padding: 22px;
      color: var(--muted);
      text-align: center;
      font-size: 14px;
    }

    .devlog-group { margin: 0 0 22px; }
    .devlog-group:last-child { margin-bottom: 0; }

    .devlog-group > .devlog-section-title {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 12px;
      font-family: "DM Sans", sans-serif;
      font-size: 13px;
      font-weight: 600;
      color: #425466;
      letter-spacing: 0.01em;
    }

    .devlog-group > .devlog-section-title .n {
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(26, 36, 48, 0.08);
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      font-weight: 500;
    }

    .devlog-record {
      border: 1px solid rgba(26, 36, 48, 0.14);
      border-left: 3px solid var(--signal);
      border-radius: 12px;
      padding: 14px 16px;
      margin: 0 0 12px;
      background: rgba(255, 255, 255, 0.55);
    }

    .devlog-record:last-child { margin-bottom: 0; }

    .devlog-record .target {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin: 0 0 10px;
      padding-bottom: 8px;
      border-bottom: 1px dashed rgba(26, 36, 48, 0.16);
      font-size: 12px;
      color: #5d6b78;
    }

    .devlog-record .target .arrow {
      font-family: "JetBrains Mono", monospace;
      color: var(--signal);
    }

    .devlog-record .target .heading {
      font-weight: 600;
      color: var(--paper-ink);
      word-break: break-all;
    }

    .devlog-record .target .ev {
      margin-left: auto;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #7a8896;
      white-space: nowrap;
    }

    .result {
      margin-top: 22px;
      border: 1px solid var(--line);
      border-radius: calc(var(--radius) + 2px);
      overflow: hidden;
      background: var(--panel);
      box-shadow: var(--shadow);
    }

    .result-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      background: rgba(0,0,0,0.18);
    }

    .result-head h3 {
      margin: 0;
      font-size: 14px;
    }

    .result-head .tools {
      display: flex;
      gap: 8px;
    }

    .ghost {
      padding: 7px 10px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--muted);
      font-size: 12px;
    }

    .ghost:hover { color: var(--ink); background: rgba(255,255,255,0.03); }

    .status-banner {
      display: none;
      margin: 0;
      padding: 12px 18px;
      font-size: 13px;
      border-bottom: 1px solid var(--line);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 180px;
      overflow: auto;
      font-family: "JetBrains Mono", monospace;
      line-height: 1.45;
    }

    .status-banner.show { display: block; }
    .status-banner.info { background: rgba(62, 207, 191, 0.08); color: var(--signal); }
    .status-banner.warn { background: rgba(240, 180, 90, 0.1); color: var(--warn); }
    .status-banner.error { background: rgba(255, 123, 114, 0.1); color: var(--danger); }

    .paper {
      background:
        linear-gradient(180deg, #f7f2e8 0%, var(--paper) 100%);
      color: var(--paper-ink);
      padding: 28px 30px 36px;
      min-height: 240px;
    }

    .paper.loading {
      display: grid;
      place-items: center;
      text-align: center;
      color: #5d6b78;
      gap: 12px;
    }

    .radar {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: 2px solid rgba(62, 207, 191, 0.25);
      position: relative;
      margin: 0 auto 8px;
    }

    .radar::before,
    .radar::after {
      content: "";
      position: absolute;
      inset: 8px;
      border-radius: 50%;
      border: 1px solid rgba(62, 207, 191, 0.2);
    }

    .radar::after {
      inset: 16px;
      border-color: rgba(62, 207, 191, 0.35);
      animation: pulse 1.4s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { transform: scale(0.92); opacity: 0.5; }
      50% { transform: scale(1.08); opacity: 1; }
    }

    .markdown {
      font-family: "Literata", Georgia, serif;
      font-size: 15.5px;
      line-height: 1.7;
      max-width: 68ch;
    }

    .markdown h1 {
      margin: 0 0 18px;
      font-size: 28px;
      letter-spacing: -0.03em;
      border-bottom: 1px solid rgba(26, 36, 48, 0.12);
      padding-bottom: 12px;
    }

    .markdown h2 {
      margin: 28px 0 10px;
      font-size: 18px;
      letter-spacing: -0.02em;
    }

    .markdown p { margin: 0 0 12px; }
    .markdown ul, .markdown ol { margin: 0 0 14px; padding-left: 1.3em; }
    .markdown li { margin: 0.25em 0; }
    .markdown code {
      font-family: "JetBrains Mono", monospace;
      font-size: 0.88em;
      background: rgba(26, 36, 48, 0.08);
      padding: 0.1em 0.35em;
      border-radius: 5px;
    }
    .markdown pre {
      background: #17212b;
      color: #e7f2f8;
      padding: 14px 16px;
      border-radius: 12px;
      overflow: auto;
      font-family: "JetBrains Mono", monospace;
      font-size: 12.5px;
      line-height: 1.55;
    }
    .markdown pre code { background: none; padding: 0; color: inherit; }
    .markdown blockquote {
      margin: 0 0 14px;
      padding: 8px 14px;
      border-left: 3px solid rgba(26, 36, 48, 0.2);
      color: #425466;
    }

    .raw {
      display: none;
      margin: 0;
      padding: 18px 20px;
      background: #0a1218;
      color: #c9dbe6;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 70vh;
      overflow: auto;
    }

    .raw.show { display: block; }
    .paper.hide { display: none; }

    .audit-tools {
      display: grid;
      grid-template-columns: 150px 160px 1fr 150px auto;
      gap: 8px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
    }

    .audit-tools input,
    .audit-tools select {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(7, 16, 24, 0.55);
      color: var(--ink);
      padding: 8px 10px;
      font: 12px "JetBrains Mono", monospace;
    }

    .audit-list { padding: 0 20px; }
    .audit-row { padding: 16px 0; border-bottom: 1px solid rgba(26, 36, 48, 0.12); }
    .audit-row:last-child { border-bottom: 0; }
    .audit-meta { color: #5d6b78; font: 12px "JetBrains Mono", monospace; }
    .audit-outcome { font-weight: 600; margin: 5px 0; }
    .audit-reason { color: #425466; font-size: 13px; line-height: 1.55; }

    @media (max-width: 820px) {
      .audit-tools { grid-template-columns: 1fr 1fr; }
      .audit-tools .audit-policy { grid-column: 1 / -1; }
    }

    @media (prefers-reduced-motion: reduce) {
      .btn-primary, .radar::after { transition: none; animation: none; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <div class="brand">
        <div class="mark">IF</div>
        <div>
          <h1>InternFlow</h1>
          <p>把今天的 Codex 会话整理成结构化日报</p>
        </div>
      </div>
      <div class="topbar-actions">
        <a class="workspace-link" href="/workspace">Engineering Memory</a>
        <div class="pill"><span class="dot"></span><span id="conn">localhost ready</span></div>
      </div>
    </div>

    <section class="hero">
      <div class="hero-main">
        <div>
          <p class="eyebrow">Codex daily report</p>
          <h2>一键试用今日日报</h2>
          <p class="lead">读取今天的 Codex 会话记录，调用 Codex 生成中文日报预览。本页只做本地预览，不会写入飞书。</p>
          <div class="stats">
            <div class="stat">
              <div class="label">Date</div>
              <div class="value" id="stat-date">—</div>
              <div class="hint" id="stat-tz">timezone</div>
            </div>
            <div class="stat">
              <div class="label">Sessions</div>
              <div class="value" id="stat-source">0</div>
              <div class="hint">原始会话</div>
            </div>
            <div class="stat">
              <div class="label">Usable</div>
              <div class="value" id="stat-activity">0</div>
              <div class="hint">可写进日报</div>
            </div>
          </div>
        </div>

        <div class="panel-side">
          <div>
            <h3>生成控制台</h3>
            <p>来源固定为今天的 Codex 会话。生成可能需要几十秒到几分钟，请保持 Codex 已登录。</p>
          </div>
          <label class="field">
            <span>模型</span>
            <input id="model" type="text" value="gpt-5.6-sol" placeholder="例如 gpt-5.6-sol" autocomplete="off" />
          </label>
          <div class="actions">
            <button class="btn-primary" id="btn-all" type="button">一键生成日报 + 需求记录</button>
            <button class="btn-secondary" id="btn-run" type="button">只生成日报</button>
            <button class="btn-secondary" id="btn-devlog" type="button">只生成需求记录增量</button>
            <button class="btn-secondary" id="btn-refresh" type="button">刷新会话状态</button>
          </div>
        </div>
      </div>
      <div class="hero-foot">
        <span id="foot-sessions">sessions: —</span>
        <span id="foot-filter">filtered: 0</span>
        <span>mode: dry-run preview</span>
      </div>
    </section>

    <section class="sessions">
      <div class="section-title">
        <h3>今日会话</h3>
        <span id="session-count">0 items</span>
      </div>
      <div class="session-list" id="session-list">
        <div class="empty">正在读取 Codex 会话…</div>
      </div>
    </section>

    <section class="result" id="result">
      <div class="result-head">
        <h3>日报预览</h3>
        <div class="tools">
          <button class="ghost" id="btn-copy" type="button">复制 Markdown</button>
          <button class="ghost" id="btn-toggle" type="button">查看源码</button>
        </div>
      </div>
      <p class="status-banner" id="banner"></p>
      <div class="paper" id="paper">
        <div class="markdown" id="markdown">
          <p style="color:#5d6b78;font-family:'DM Sans',sans-serif;">点击上方按钮，用今天的 Codex 会话生成日报。</p>
        </div>
      </div>
      <pre class="raw" id="raw"></pre>
    </section>

    <section class="result" id="devlog-result">
      <div class="result-head">
        <h3>需求开发记录 · 待补充增量</h3>
        <div class="tools">
          <span class="ghost" id="devlog-outline-badge" style="pointer-events:none">outline: —</span>
        </div>
      </div>
      <p class="status-banner" id="devlog-banner"></p>
      <div class="paper" id="devlog-paper">
        <div class="markdown">
          <p style="color:#5d6b78;font-family:'DM Sans',sans-serif;">点击“生成需求记录增量”，预览今天要追加到飞书需求文档的内容。只显示还没同步过的部分。</p>
        </div>
      </div>
    </section>

    <section class="result" id="audit-result">
      <div class="result-head">
        <h3>决策审计</h3>
        <div class="tools"><span class="ghost" id="audit-count" style="pointer-events:none">0 decisions</span></div>
      </div>
      <div class="audit-tools">
        <input id="audit-date" type="date" aria-label="审计日期" />
        <select id="audit-job" aria-label="任务">
          <option value="">全部任务</option>
          <option value="daily-report">日报</option>
          <option value="dev-log">需求记录</option>
          <option value="weekly-report">周报</option>
          <option value="monthly-report">月报</option>
        </select>
        <input class="audit-policy" id="audit-policy" type="text" placeholder="策略，例如 daily.visual-need" aria-label="策略" />
        <input id="audit-outcome" type="text" placeholder="结果" aria-label="结果" />
        <button class="ghost" id="btn-audit" type="button">查询</button>
      </div>
      <p class="status-banner" id="audit-banner"></p>
      <div class="paper audit-list" id="audit-list"><div class="empty">暂无审计记录</div></div>
    </section>
  </div>

  <script>
    const els = {
      conn: document.getElementById('conn'),
      date: document.getElementById('stat-date'),
      tz: document.getElementById('stat-tz'),
      source: document.getElementById('stat-source'),
      activity: document.getElementById('stat-activity'),
      sessions: document.getElementById('foot-sessions'),
      filter: document.getElementById('foot-filter'),
      list: document.getElementById('session-list'),
      count: document.getElementById('session-count'),
      run: document.getElementById('btn-run'),
      all: document.getElementById('btn-all'),
      devlog: document.getElementById('btn-devlog'),
      refresh: document.getElementById('btn-refresh'),
      model: document.getElementById('model'),
      copy: document.getElementById('btn-copy'),
      toggle: document.getElementById('btn-toggle'),
      banner: document.getElementById('banner'),
      paper: document.getElementById('paper'),
      markdown: document.getElementById('markdown'),
      raw: document.getElementById('raw'),
      devlogBanner: document.getElementById('devlog-banner'),
      devlogPaper: document.getElementById('devlog-paper'),
      devlogBadge: document.getElementById('devlog-outline-badge'),
      auditDate: document.getElementById('audit-date'),
      auditJob: document.getElementById('audit-job'),
      auditPolicy: document.getElementById('audit-policy'),
      auditOutcome: document.getElementById('audit-outcome'),
      auditRun: document.getElementById('btn-audit'),
      auditBanner: document.getElementById('audit-banner'),
      auditList: document.getElementById('audit-list'),
      auditCount: document.getElementById('audit-count'),
    };

    let latestMarkdown = '';
    let showRaw = false;
    let busy = false;
    let webToken = sessionStorage.getItem('internflow.webToken') || '';

    async function apiFetch(path, options = {}) {
      const request = async () => {
        const headers = new Headers(options.headers || {});
        if (webToken) headers.set('authorization', 'Bearer ' + webToken);
        return fetch(path, { ...options, headers });
      };
      let response = await request();
      if (response.status !== 401) return response;

      const token = window.prompt('请输入 InternFlow Web 访问令牌');
      if (!token) return response;
      await response.body?.cancel();
      webToken = token.trim();
      sessionStorage.setItem('internflow.webToken', webToken);
      response = await request();
      if (response.status === 401) {
        webToken = '';
        sessionStorage.removeItem('internflow.webToken');
      }
      return response;
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function renderInline(text) {
      return escapeHtml(text)
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
    }

    function markdownToHtml(md) {
      const lines = md.replace(/\\r\\n?/g, '\\n').split('\\n');
      const html = [];
      let inList = false;
      let inCode = false;
      let code = [];

      const closeList = () => {
        if (inList) { html.push('</ul>'); inList = false; }
      };

      for (const line of lines) {
        if (line.startsWith('\`\`\`')) {
          if (inCode) {
            html.push('<pre><code>' + escapeHtml(code.join('\\n')) + '</code></pre>');
            code = [];
            inCode = false;
          } else {
            closeList();
            inCode = true;
          }
          continue;
        }
        if (inCode) { code.push(line); continue; }

        if (/^#\\s+/.test(line)) {
          closeList();
          html.push('<h1>' + renderInline(line.replace(/^#\\s+/, '')) + '</h1>');
          continue;
        }
        if (/^##\\s+/.test(line)) {
          closeList();
          html.push('<h2>' + renderInline(line.replace(/^##\\s+/, '')) + '</h2>');
          continue;
        }
        if (/^###\\s+/.test(line)) {
          closeList();
          html.push('<h3>' + renderInline(line.replace(/^###\\s+/, '')) + '</h3>');
          continue;
        }
        if (/^[-*]\\s+/.test(line)) {
          if (!inList) { html.push('<ul>'); inList = true; }
          html.push('<li>' + renderInline(line.replace(/^[-*]\\s+/, '')) + '</li>');
          continue;
        }
        if (!line.trim()) {
          closeList();
          continue;
        }
        closeList();
        html.push('<p>' + renderInline(line) + '</p>');
      }
      closeList();
      if (inCode) html.push('<pre><code>' + escapeHtml(code.join('\\n')) + '</code></pre>');
      return html.join('');
    }

    function setBannerOn(node, type, text) {
      if (!text) {
        node.className = 'status-banner';
        node.textContent = '';
        return;
      }
      node.className = 'status-banner show ' + type;
      node.textContent = text;
    }

    function setBanner(type, text) {
      setBannerOn(els.banner, type, text);
    }

    function setDevlogBanner(type, text) {
      setBannerOn(els.devlogBanner, type, text);
    }

    function renderSessions(activities) {
      els.count.textContent = activities.length + ' items';
      if (!activities.length) {
        els.list.innerHTML = '<div class="empty">今天还没有可写进日报的 Codex 会话。先用 Codex 做点开发工作，再回来生成。</div>';
        return;
      }
      els.list.innerHTML = activities.map((item) => {
        const minutes = item.activeMinutes == null ? 'n/a' : (item.activeMinutes + 'm');
        return (
          '<article class="session">' +
            '<div class="title">' + escapeHtml(item.title || item.id) + '</div>' +
            '<div class="chip">' + escapeHtml(minutes) + '</div>' +
            '<div class="meta">' +
              escapeHtml(item.cwd || '—') +
              (item.gitBranch ? ' · ' + escapeHtml(item.gitBranch) : '') +
              '<br/>msgs ' + item.userMessageCount +
              ' · cmds ' + item.commandCount +
              ' · files ' + item.changedFileCount +
            '</div>' +
          '</article>'
        );
      }).join('');
    }

    function applyStatus(data) {
      els.date.textContent = data.date || '—';
      if (!els.auditDate.value && data.date) els.auditDate.value = data.date;
      els.tz.textContent = data.timezone || 'timezone';
      els.source.textContent = String(data.sourceCount ?? 0);
      els.activity.textContent = String(data.activityCount ?? 0);
      els.sessions.textContent = 'sessions: ' + (data.sessionsDir || '—');
      els.filter.textContent = 'filtered: ' + (data.filteredCount ?? 0);
      renderSessions(data.activities || []);
      if (data.error) {
        els.conn.textContent = 'status error';
        setBanner('error', data.error);
      } else {
        els.conn.textContent = 'localhost ready';
      }
    }

    async function refreshStatus() {
      const res = await apiFetch('/api/status');
      const data = await res.json();
      applyStatus(data);
      return data;
    }

    function setBusy(next) {
      busy = next;
      els.run.disabled = next;
      els.all.disabled = next;
      els.devlog.disabled = next;
      els.refresh.disabled = next;
    }

    function showLoading() {
      setBanner('info', '正在读取今日 Codex 会话并调用 Codex 生成日报…');
      els.paper.classList.remove('hide');
      els.raw.classList.remove('show');
      showRaw = false;
      els.toggle.textContent = '查看源码';
      els.paper.classList.add('loading');
      els.paper.innerHTML = '<div><div class="radar"></div><div>Codex 正在整理今日工作记录</div><div style="font-size:12px;margin-top:6px;opacity:.75">通常需要几十秒，请不要关闭页面</div></div>';
    }

    function showMarkdown(md, meta, options = {}) {
      latestMarkdown = md || '';
      els.paper.classList.remove('loading');
      els.paper.classList.remove('hide');
      els.raw.classList.remove('show');
      showRaw = false;
      els.toggle.textContent = '查看源码';
      els.paper.innerHTML = '<div class="markdown" id="markdown"></div>';
      const node = document.getElementById('markdown');
      if (!md) {
        node.innerHTML = '<p style="color:#5d6b78;font-family:\\'DM Sans\\',sans-serif;">没有生成内容。</p>';
      } else {
        node.innerHTML = markdownToHtml(md);
      }
      els.raw.textContent = md || '';
      // Keep session stats when generation fails with empty activities.
      if (meta && (options.forceStatus || (meta.activities && meta.activities.length) || meta.activityCount > 0 || meta.sourceCount > 0)) {
        applyStatus(meta);
      }
    }

    async function generateReport() {
      showLoading();
      const model = (els.model.value || '').trim() || 'gpt-5.6-sol';
      try {
        const res = await apiFetch('/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        const data = await res.json();
        if (!data.ok) {
          showMarkdown('', data);
          setBanner('error', data.error || '生成失败');
          refreshStatus().catch(() => {});
          return false;
        }
        if (data.skipped) {
          showMarkdown('', data, { forceStatus: true });
          setBanner('warn', data.reason || '今天没有可生成的会话');
          return true;
        }
        showMarkdown(data.markdown || '', data, { forceStatus: true });
        setBanner('info', '已根据 ' + data.activityCount + ' 个会话生成 ' + data.date + ' 日报预览（model: ' + model + '）');
        return true;
      } catch (error) {
        showMarkdown('');
        setBanner('error', error instanceof Error ? error.message : String(error));
        refreshStatus().catch(() => {});
        return false;
      }
    }

    function showDevlogLoading() {
      setDevlogBanner('info', '正在调用 Codex 生成需求开发记录增量…');
      els.devlogPaper.classList.add('loading');
      els.devlogPaper.innerHTML = '<div><div class="radar"></div><div>Codex 正在核对证据并生成待补充增量</div><div style="font-size:12px;margin-top:6px;opacity:.75">通常需要几十秒，请不要关闭页面</div></div>';
    }

    function setOutlineBadge(usedLarkOutline, skipped) {
      if (skipped) { els.devlogBadge.textContent = 'outline: —'; return; }
      els.devlogBadge.textContent = usedLarkOutline ? 'outline: 飞书真实' : 'outline: 虚拟三章节';
    }

    function renderDevlogRecords(records) {
      els.devlogPaper.classList.remove('loading');
      const order = ['overview', 'requirement', 'bugfix', 'insight'];
      const groups = {};
      for (const record of records) {
        (groups[record.section] = groups[record.section] || []).push(record);
      }
      const html = order.filter((section) => groups[section]).map((section) => {
        const items = groups[section];
        const cards = items.map((record) => (
          '<article class="devlog-record">' +
            '<div class="target">' +
              '<span class="arrow">└─▸</span>' +
              '<span class="heading">' + escapeHtml(record.targetHeading || '(未匹配到标题)') + '</span>' +
              '<span class="ev">' + escapeHtml(record.operation || 'append') + '</span>' +
              (record.evidenceCount ? '<span class="ev">evidence ×' + record.evidenceCount + '</span>' : '') +
            '</div>' +
            '<div class="markdown">' + markdownToHtml(record.markdown || '') + '</div>' +
          '</article>'
        )).join('');
        return (
          '<div class="devlog-group">' +
            '<div class="devlog-section-title">' + escapeHtml(items[0].sectionLabel) +
              '<span class="n">' + items.length + '</span></div>' +
            cards +
          '</div>'
        );
      }).join('');
      els.devlogPaper.innerHTML = html || '<div class="markdown"><p style="color:#5d6b78;font-family:\\'DM Sans\\',sans-serif;">没有生成内容。</p></div>';
    }

    async function generateDevlog() {
      showDevlogLoading();
      const model = (els.model.value || '').trim() || 'gpt-5.6-sol';
      try {
        const res = await apiFetch('/api/generate-devlog', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        const data = await res.json();
        setOutlineBadge(data.usedLarkOutline, data.skipped);
        if (!data.ok) {
          els.devlogPaper.classList.remove('loading');
          els.devlogPaper.innerHTML = '<div class="markdown"><p style="color:#5d6b78;font-family:\\'DM Sans\\',sans-serif;">生成失败。</p></div>';
          setDevlogBanner('error', data.error || '生成失败');
          return false;
        }
        if (data.skipped) {
          els.devlogPaper.classList.remove('loading');
          els.devlogPaper.innerHTML = '<div class="markdown"><p style="color:#5d6b78;font-family:\\'DM Sans\\',sans-serif;">' + escapeHtml(data.reason || '没有待补充的增量。') + '</p></div>';
          setDevlogBanner('warn', data.reason || '没有待补充的增量');
          return true;
        }
        renderDevlogRecords(data.records || []);
        const outlineNote = data.usedLarkOutline ? '（已对齐飞书真实 outline）' : '（未配置飞书文档，用虚拟三章节占位）';
        setDevlogBanner('info', '共 ' + (data.records || []).length + ' 条待补充增量 · ' + data.date + ' ' + outlineNote);
        return true;
      } catch (error) {
        els.devlogPaper.classList.remove('loading');
        setDevlogBanner('error', error instanceof Error ? error.message : String(error));
        return false;
      }
    }

    async function loadAudits() {
      const params = new URLSearchParams({ date: els.auditDate.value });
      if (els.auditJob.value) params.set('job', els.auditJob.value);
      if (els.auditPolicy.value.trim()) params.set('policy', els.auditPolicy.value.trim());
      if (els.auditOutcome.value.trim()) params.set('outcome', els.auditOutcome.value.trim());
      setBannerOn(els.auditBanner, 'info', '正在读取决策审计…');
      try {
        const response = await apiFetch('/api/decision-audits?' + params.toString());
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || '读取审计失败');
        const decisions = (data.audits || []).flatMap((audit) => (
          (audit.assessments || []).map((assessment) => ({ ...assessment, job: audit.job }))
        ));
        els.auditCount.textContent = decisions.length + ' decisions';
        els.auditList.innerHTML = decisions.length ? decisions.map((item) => {
          const reason = (item.reasons || []).map((value) => value.message).join('；');
          return '<article class="audit-row">' +
            '<div class="audit-meta">' + escapeHtml(item.job + ' · ' + item.policyId + '@' + item.policyVersion + ' · ' + item.confidence) + '</div>' +
            '<div class="audit-outcome">' + escapeHtml(item.outcome) + '</div>' +
            '<div class="audit-reason">' + escapeHtml(reason || '未记录原因') + '</div>' +
          '</article>';
        }).join('') : '<div class="empty">没有符合条件的决策记录</div>';
        setBannerOn(els.auditBanner, '', '');
      } catch (error) {
        els.auditCount.textContent = '0 decisions';
        els.auditList.innerHTML = '<div class="empty">读取失败</div>';
        setBannerOn(els.auditBanner, 'error', error instanceof Error ? error.message : String(error));
      }
    }

    async function runReport() {
      if (busy) return;
      setBusy(true);
      try { await generateReport(); } finally { setBusy(false); }
    }

    async function runDevlog() {
      if (busy) return;
      setBusy(true);
      try { await generateDevlog(); } finally { setBusy(false); }
    }

    async function runAll() {
      if (busy) return;
      setBusy(true);
      try {
        const ok = await generateReport();
        // 日报硬失败（非 skipped）时不再继续，避免连锁误导。
        if (ok) await generateDevlog();
      } finally {
        setBusy(false);
      }
    }

    els.refresh.addEventListener('click', () => {
      refreshStatus().catch((error) => setBanner('error', String(error)));
    });
    els.run.addEventListener('click', () => { runReport(); });
    els.devlog.addEventListener('click', () => { runDevlog(); });
    els.all.addEventListener('click', () => { runAll(); });
    els.auditRun.addEventListener('click', () => { loadAudits(); });
    els.copy.addEventListener('click', async () => {
      if (!latestMarkdown) {
        setBanner('warn', '还没有可复制的 Markdown');
        return;
      }
      try {
        await navigator.clipboard.writeText(latestMarkdown);
        setBanner('info', '已复制 Markdown 到剪贴板');
      } catch {
        setBanner('error', '复制失败，请改用“查看源码”手动复制');
      }
    });
    els.toggle.addEventListener('click', () => {
      showRaw = !showRaw;
      els.raw.classList.toggle('show', showRaw);
      els.paper.classList.toggle('hide', showRaw);
      els.toggle.textContent = showRaw ? '查看排版' : '查看源码';
    });

    refreshStatus()
      .then(() => loadAudits())
      .catch((error) => setBanner('error', String(error)));
  </script>
</body>
</html>`;
}
