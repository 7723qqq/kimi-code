/* Kimi Code Web prototype — settings pages feature module.
   Renders the four settings tabs (general / agent / account / advanced) into
   the existing `.st-panel` container and wires tab switching. Self-contained:
   only touches `.st-panel`, never the modal shell / nav markup in index.html. */
(function () {
  'use strict';

  var KP = function () { return window.KP; };
  var tab = 'general';

  /* ----------------------------- markup helpers ------------------------- */
  function panelHead(kicker, title, desc) {
    return '<div class="ph-kicker">' + KP().esc(kicker) + '</div>' +
      '<h3 class="ph-title">' + KP().esc(title) + '</h3>' +
      '<p class="ph-desc">' + KP().esc(desc) + '</p>';
  }
  function row(name, desc, ctrl) {
    return '<div class="srow"><div><div class="name">' + KP().esc(name) + '</div>' +
      (desc ? '<div class="desc">' + KP().esc(desc) + '</div>' : '') +
      '</div><div class="ctrl">' + ctrl + '</div></div>';
  }
  function sw(key, on) {
    return '<button class="sw' + (on ? ' on' : '') + '" data-st-sw="' + key + '"><i></i></button>';
  }
  function seg(key, value, opts) {
    var h = '<div class="seg" data-st-seg="' + key + '">';
    opts.forEach(function (o) {
      h += '<button' + (o.v === value ? ' class="on"' : '') + ' data-st-val="' + o.v + '">' + KP().esc(o.l) + '</button>';
    });
    return h + '</div>';
  }

  /* ----------------------------- general -------------------------------- */
  // Reproduced EXACTLY from the static `.st-panel` markup in index.html so the
  // look (and app.js's data-seg/data-sw/data-fontsize handlers) is unchanged.
  function renderGeneral() {
    return '' +
      '<div class="ph-kicker">GENERAL</div>' +
      '<h3 class="ph-title">通用</h3>' +
      '<p class="ph-desc">管理外观、通知、偏好引导和通用能力设置。</p>' +

      '<div class="card">' +
        '<div class="card-title">外观</div>' +
        '<div class="srow">' +
          '<div><div class="name">明暗</div><div class="desc">选择界面主题，默认跟随系统。</div></div>' +
          '<div class="ctrl"><div class="seg" data-seg><button class="on">月之亮面</button><button>月之暗面</button><button>跟随系统</button></div></div>' +
        '</div>' +
        '<div class="srow">' +
          '<div><div class="name">字体大小</div><div class="desc">对话与代码块的基础字号。</div></div>' +
          '<div class="ctrl"><span class="num"><input data-fontsize type="number" min="12" max="20" value="14"><span class="u">px</span></span></div>' +
        '</div>' +
        '<div class="srow">' +
          '<div><div class="name">语言</div><div class="desc">界面显示语言。</div></div>' +
          '<div class="ctrl"><div class="seg" data-seg><button>English</button><button class="on">中文</button></div></div>' +
        '</div>' +
        '<div class="srow">' +
          '<div><div class="name">显示对话目录</div><div class="desc">在右侧显示可点击跳转的对话目录。</div></div>' +
          '<div class="ctrl"><button class="sw on" data-sw><i></i></button></div>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title">通知</div>' +
        '<div class="srow">' +
          '<div><div class="name">会话完成时通知</div><div class="desc">Agent 完成任务后发送系统通知。</div></div>' +
          '<div class="ctrl"><button class="sw on" data-sw><i></i></button></div>' +
        '</div>' +
        '<div class="srow">' +
          '<div><div class="name">待回答时通知</div><div class="desc">有待回答的提问时发送系统通知。</div></div>' +
          '<div class="ctrl"><button class="sw on" data-sw><i></i></button></div>' +
        '</div>' +
        '<div class="srow">' +
          '<div><div class="name">会话完成或待回答时播放提示音</div></div>' +
          '<div class="ctrl"><button class="sw" data-sw><i></i></button></div>' +
        '</div>' +
      '</div>';
  }

  /* ----------------------------- agent ---------------------------------- */
  function modelSelect(S) {
    var groups = {};
    var order = [];
    S.models.forEach(function (m) {
      if (!groups[m.provider]) { groups[m.provider] = []; order.push(m.provider); }
      groups[m.provider].push(m);
    });
    var h = '<select class="st-select" data-st-model>';
    order.forEach(function (p) {
      var label = p.charAt(0).toUpperCase() + p.slice(1);
      h += '<optgroup label="' + KP().esc(label) + '">';
      groups[p].forEach(function (m) {
        h += '<option value="' + m.id + '"' + (m.id === S.config.defaultModel ? ' selected' : '') + '>' + KP().esc(m.name) + '</option>';
      });
      h += '</optgroup>';
    });
    return h + '</select>';
  }

  function renderAgent(S) {
    var c = S.config;
    return panelHead('AGENT', 'Agent', '新会话的默认模型、权限、思考等。') +
      '<div class="card">' +
        '<div class="card-title">默认值</div>' +
        row('默认模型', '新建会话时使用的模型。', modelSelect(S)) +
        row('默认权限', '新会话的工具执行权限。', seg('defaultPermission', c.defaultPermission, [
          { v: 'manual', l: '手动' }, { v: 'auto', l: '自动' }, { v: 'yolo', l: 'YOLO' },
        ])) +
        row('默认开启思考', '新会话默认启用思考过程。', sw('defaultThinking', !!c.defaultThinking)) +
        row('默认计划模式', '新会话默认进入计划模式。', sw('defaultPlanMode', !!c.defaultPlanMode)) +
        row('合并所有可用 Skills', '把已启用的 Skills 注入每次会话。', sw('mergeSkills', !!c.mergeSkills)) +
      '</div>';
  }

  /* ----------------------------- account -------------------------------- */
  function renderAccount() {
    return panelHead('ACCOUNT', '账户', '登录状态与当前会话。') +
      '<div class="card">' +
        '<div class="card-title">当前账户</div>' +
        row('托管模型', '由 Kimi Code 托管的默认模型来源。', '<span class="mono muted">managed:kimi-code</span>') +
        '<div class="srow">' +
          '<div><div class="name">会话</div><div class="desc">重新打开引导，或退出当前账户。</div></div>' +
          '<div class="ctrl" style="display:flex;gap:8px">' +
            '<button class="btn btn-secondary" data-st-act="onboarding">重新打开新手引导</button>' +
            '<button class="btn btn-danger" data-st-act="logout">退出登录</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  /* ----------------------------- advanced ------------------------------- */
  function renderAdvanced(S) {
    var c = S.config;
    return panelHead('ADVANCED', '高级', '诊断、数据与隐私。') +
      '<div class="card">' +
        '<div class="card-title">服务</div>' +
        row('服务地址', '本地 daemon 监听地址。', '<span class="mono muted">' + KP().esc(c.daemon) + '</span>') +
        row('服务端版本', '当前连接的服务版本。', '<span class="mono muted">' + KP().esc(c.serverVersion) + '</span>') +
      '</div>' +
      '<div class="card">' +
        '<div class="card-title">数据</div>' +
        row('使用数据改进产品', '匿名收集使用数据，帮助我们改进产品。', sw('telemetry', !!c.telemetry)) +
        row('导出故障排查日志', '打包诊断信息用于排查问题。', '<button class="btn btn-secondary" data-st-act="export-logs">导出日志</button>') +
      '</div>';
  }

  /* ----------------------------- render --------------------------------- */
  function render() {
    var api = KP();
    if (!api) return;
    var S = api.Store;
    var panel = document.querySelector('.st-panel');
    if (!panel) return;
    var scroll = panel.scrollTop;
    var html;
    switch (tab) {
      case 'agent': html = renderAgent(S); break;
      case 'account': html = renderAccount(S); break;
      case 'advanced': html = renderAdvanced(S); break;
      default: html = renderGeneral(); break;
    }
    panel.innerHTML = html;
    panel.scrollTop = scroll;

    // sync nav active state (we do not re-render the nav itself)
    var items = document.querySelectorAll('.st-nav .nav-item[data-tab]');
    [].forEach.call(items, function (it) {
      it.classList.toggle('on', it.getAttribute('data-tab') === tab);
    });
  }

  /* ----------------------------- wiring --------------------------------- */
  document.addEventListener('click', function (e) {
    // open trigger → render after app.js opens the overlay
    if (e.target.closest('[data-open-settings]')) { setTimeout(render, 0); return; }

    // tab switching
    var nav = e.target.closest('.nav-item[data-tab]');
    if (nav) { tab = nav.getAttribute('data-tab') || 'general'; render(); return; }

    // agent / advanced segmented
    var segBtn = e.target.closest('[data-st-seg] button[data-st-val]');
    if (segBtn) {
      var key = segBtn.parentNode.getAttribute('data-st-seg');
      var api2 = KP(); if (api2) { api2.Store.config[key] = segBtn.getAttribute('data-st-val'); render(); }
      return;
    }

    // agent / advanced switch (boolean config keys)
    var swEl = e.target.closest('[data-st-sw]');
    if (swEl) {
      var k = swEl.getAttribute('data-st-sw');
      var api3 = KP(); if (api3) { api3.Store.config[k] = !api3.Store.config[k]; render(); }
      return;
    }

    // account / advanced actions
    var act = e.target.closest('[data-st-act]');
    if (act) {
      var a = act.getAttribute('data-st-act');
      var api4 = KP(); if (!api4) return;
      if (a === 'onboarding') { api4.toast('已重新打开新手引导（stub）'); return; }
      if (a === 'export-logs') { api4.toast('已导出（stub）'); return; }
      if (a === 'logout') {
        api4.confirm({
          title: '退出登录',
          message: '确定要退出当前账户吗？',
          onConfirm: function () { api4.toast('已退出（stub）'); },
        });
        return;
      }
    }
  });

  // model <select> change
  document.addEventListener('change', function (e) {
    var sel = e.target.closest('[data-st-model]');
    if (sel) { var api = KP(); if (api) { api.Store.config.defaultModel = sel.value; render(); } }
  });

  // re-render whenever the settings overlay opens (covers URL / programmatic open)
  var overlay = document.querySelector('[data-overlay="settings"]');
  if (overlay) {
    new MutationObserver(function () {
      if (overlay.classList.contains('is-open')) render();
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }

  // entry point for app.js
  window.KP_renderSettings = render;
})();
