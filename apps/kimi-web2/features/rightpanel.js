/* Kimi Code Web prototype — feature module: right-side slide-in detail panel.
 * Self-contained: injects an <aside class="rpanel"> into #feature-mount, self-wires
 * document listeners, and exposes window.KP_togglePanel. It is a sliding panel, not
 * a masked overlay; content is stub data for design evaluation.
 */
(function () {
  'use strict';

  function KP() { return window.KP || {}; }
  function esc(s) {
    var f = KP().esc;
    return f ? f(s) : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function ic(id, cls) {
    var f = KP().icon;
    return f ? f(id, cls) : '<svg' + (cls ? ' class="' + cls + '"' : '') + '><use href="#' + id + '"/></svg>';
  }

  var KINDS = [
    { id: 'think', label: '思考' },
    { id: 'diff', label: 'Diff' },
    { id: 'file', label: '文件' },
  ];
  var DEFAULT_KIND = 'think';

  var state = { open: false, kind: DEFAULT_KIND };
  var panelEl = null;

  /* --------------------------- stub content ------------------------------- */
  // NOTE: stub code/diff text intentionally avoids a literal "&" so esc() (which
  // converts & < >) stays a no-op for everything except the angle brackets we want
  // shown as text. No backticks / "${}" appear inside, so the template is safe.
  var CODE = [
    "(function () {",
    "  'use strict';",
    "  var S = window.Store;",
    "  var root = document.documentElement;",
    "",
    "  function t(k) {",
    "    return (I[S.state.lang] || I.zh)[k] || k;",
    "  }",
    "",
    "  function icon(id, cls) {",
    "    return '<svg><use href=\"#' + id + '\"/></svg>';",
    "  }",
    "",
    "  function renderAll() {",
    "    renderSidebar();",
    "    renderTopbar();",
    "    renderConv();",
    "    syncComposer();",
    "  }",
    "",
    "  S.subscribe(renderAll);",
    "  renderAll();",
    "})();",
  ].join('\n');

  var DIFF = [
    { t: 'ctx', s: '  --c-brand: rgba(0, 0, 0, 0.9);' },
    { t: 'ctx', s: '  --c-brand-hover: rgba(37, 37, 37, 1);' },
    { t: 'del', s: '- --c-accent: #1783ff;' },
    { t: 'add', s: '+ --c-info:   #1783ff;  /* brand / data only */' },
    { t: 'ctx', s: '  --radius-md: 10px;' },
    { t: 'del', s: '- --color-blue-soft: rgba(23, 131, 255, 0.1);' },
    { t: 'add', s: '+ --c-blue-soft: rgba(23, 131, 255, 0.1);' },
    { t: 'ctx', s: '  --ease: cubic-bezier(0.23, 1, 0.32, 1);' },
  ];

  function labelOf(id) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].id === id) return KINDS[i].label;
    return id;
  }

  /* ----------------------------- render ----------------------------------- */
  function thinkHTML() {
    return '<h3 class="rp-h">思考过程</h3>' +
      '<div class="rp-think">' +
        '<p>用户说“看不出区别”且“和例子大相径庭”。最可能的根因不是样式没改，而是旧的蓝色强调偏好把中性强调色盖掉了。</p>' +
        '<p>设计上，Kimi 的交互强调是 kimiDark（近黑 / 近白），蓝色只给品牌与数据。所以移除蓝色强调项，让默认体验回归中性，是第一刀。</p>' +
        '<p>接下来用同样的 token 重做侧栏与聊天主表面：状态一律用填充而非边框，hairline 分隔保持克制。</p>' +
      '</div>';
  }

  function diffHTML() {
    var rows = DIFF.map(function (d) {
      var sign = d.t === 'add' ? '+' : (d.t === 'del' ? '-' : '\u00a0');
      var cls = d.t === 'add' ? ' rp-dadd' : (d.t === 'del' ? ' rp-ddel' : '');
      var text = d.s.replace(/^[+\- ]/, ''); // marker lives in the gutter; strip it from the code
      return '<div class="rp-dline' + cls + '">' +
        '<span class="rp-sign">' + sign + '</span>' +
        '<span class="rp-dt">' + esc(text) + '</span>' +
      '</div>';
    }).join('');
    return '<div class="rp-file-head">prototype/styles.css</div>' +
      '<div class="rp-diff">' + rows + '</div>';
  }

  function fileHTML() {
    var rows = CODE.split('\n').map(function (ln, i) {
      return '<div class="rp-cline">' +
        '<span class="rp-ln">' + (i + 1) + '</span>' +
        '<span class="rp-cc">' + esc(ln) + '</span>' +
      '</div>';
    }).join('');
    return '<div class="rp-file-head">prototype/app.js</div>' +
      '<div class="rp-code">' + rows + '</div>';
  }

  function bodyHTML(kind) {
    if (kind === 'diff') return diffHTML();
    if (kind === 'file') return fileHTML();
    return thinkHTML();
  }

  function renderBody() {
    if (!panelEl) return;
    var body = panelEl.querySelector('[data-rp-body]');
    var title = panelEl.querySelector('[data-rp-title]');
    if (body) body.innerHTML = bodyHTML(state.kind);
    if (title) title.textContent = labelOf(state.kind);
    var seg = panelEl.querySelector('[data-rp-seg]');
    if (seg) {
      [].forEach.call(seg.children, function (b) {
        b.classList.toggle('on', b.getAttribute('data-rp-kind') === state.kind);
      });
    }
  }

  function skeleton() {
    var segBtns = KINDS.map(function (k, i) {
      return '<button' + (i === 0 ? ' class="on"' : '') + ' data-rp-kind="' + k.id + '">' + k.label + '</button>';
    }).join('');
    return '<aside class="rpanel" data-rp>' +
      '<header class="rp-head">' +
        '<span class="rp-title" data-rp-title>' + labelOf(DEFAULT_KIND) + '</span>' +
        '<div class="seg" data-rp-seg>' + segBtns + '</div>' +
        '<button class="ic-btn" aria-label="关闭" data-rp-close>' + ic('i-close') + '</button>' +
      '</header>' +
      '<div class="rp-body" data-rp-body>' + bodyHTML(DEFAULT_KIND) + '</div>' +
    '</aside>';
  }

  /* ----------------------------- mount ------------------------------------ */
  function mount() {
    if (panelEl) return panelEl;
    var host = document.getElementById('feature-mount');
    if (!host || host.querySelector('[data-rp]')) { panelEl = host && host.querySelector('[data-rp]'); return panelEl; }
    host.insertAdjacentHTML('beforeend', skeleton());
    panelEl = host.querySelector('[data-rp]');
    return panelEl;
  }

  /* --------------------------- open / close -------------------------------- */
  function open(kind) {
    if (!mount()) return;
    state.kind = kind || state.kind || DEFAULT_KIND;
    renderBody();
    state.open = true;
    panelEl.classList.add('is-open');
  }
  function close() {
    if (!panelEl) return;
    state.open = false;
    panelEl.classList.remove('is-open');
  }
  function toggle(kind) {
    if (state.open) close();
    else open(kind || DEFAULT_KIND);
  }

  /* --------------------------- self-wire ---------------------------------- */
  document.addEventListener('click', function (e) {
    // topbar button (re-rendered by app.js) -> delegate on document
    if (e.target.closest('[data-act="toggle-panel"]')) { toggle(DEFAULT_KIND); return; }

    // panel controls
    if (e.target.closest('[data-rp-close]')) { close(); return; }
    var kindBtn = e.target.closest('[data-rp-kind]');
    if (kindBtn && panelEl && panelEl.contains(kindBtn)) {
      var k = kindBtn.getAttribute('data-rp-kind');
      if (k && k !== state.kind) { state.kind = k; renderBody(); }
      return;
    }

    // nice touch: open (思考) when a tool row or thinking header is clicked
    if (e.target.closest('.tool-row') || e.target.closest('.th-head')) { open('think'); return; }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.open) close();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.KP_togglePanel = toggle;
})();
