/* Kimi Code Web prototype — feature module: managed OAuth device-code login (UI only).
 * Self-contained: injects its overlay into #feature-mount, self-wires document listeners,
 * and exposes window.KP_openLogin. No real OAuth; all transitions are timed stubs.
 */
(function () {
  'use strict';

  function KP() { return window.KP || {}; }
  function ic(id, cls) {
    var f = KP().icon;
    return f ? f(id, cls) : '<svg' + (cls ? ' class="' + cls + '"' : '') + '><use href="#' + id + '"/></svg>';
  }

  var CODE = 'ABCD-1234';
  var START_SECONDS = 598; // 9:58

  var step = 'starting';     // starting | code | success | expired
  var remaining = START_SECONDS;
  var authorizing = false;

  var tStart = null;         // starting -> code
  var tSuccess = null;       // authorize -> success
  var tClose = null;         // success -> close
  var tickId = null;         // countdown interval

  function clearTimers() {
    if (tStart) { clearTimeout(tStart); tStart = null; }
    if (tSuccess) { clearTimeout(tSuccess); tSuccess = null; }
    if (tClose) { clearTimeout(tClose); tClose = null; }
    if (tickId) { clearInterval(tickId); tickId = null; }
  }

  function fmt(s) {
    s = Math.max(0, s | 0);
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function hasIcon(id) { return !!document.getElementById(id); }

  /* ----------------------------- render --------------------------------- */
  function skeleton() {
    return '<div class="overlay" data-overlay="login">' +
      '<section class="modal login-modal" role="dialog" aria-modal="true" aria-labelledby="loginTitle">' +
        '<header class="login-head">' +
          '<h2 id="loginTitle">登录 Kimi Code</h2>' +
          '<button class="ic-btn" aria-label="关闭" data-close>' + ic('i-close') + '</button>' +
        '</header>' +
        '<div class="login-body" data-login-body></div>' +
      '</section>' +
    '</div>';
  }

  function startingHTML() {
    return '<div class="login-state">' +
      '<span class="spin"></span>' +
      '<div class="login-state-t">正在启动登录流程…</div>' +
    '</div>';
  }

  function codeHTML() {
    var ext = hasIcon('i-external') ? 'i-external' : 'i-arrow-up';
    return '<p class="login-lead">在浏览器中打开链接完成授权，登录即同步到你的账户。</p>' +
      '<button class="btn btn-primary login-auth-btn" data-act="login-authorize">' +
        ic(ext) + '<span>在浏览器中授权并登录</span>' +
      '</button>' +
      '<div class="login-or"><span>或</span></div>' +
      '<p class="login-fallback">也可以打开 kimi.com/code 并输入以下验证码：</p>' +
      '<div class="login-code-row">' +
        '<span class="login-code">' + CODE + '</span>' +
        '<button class="btn btn-secondary" data-act="login-copy">复制</button>' +
      '</div>' +
      '<div class="login-status">' +
        '<span class="spin"></span>' +
        '<span class="login-status-t">等待授权中…</span>' +
        '<span class="login-countdown" data-login-countdown>' + fmt(remaining) + '</span>' +
      '</div>';
  }

  function successHTML() {
    return '<div class="login-state">' +
      '<span class="login-check">' + ic('i-check') + '</span>' +
      '<div class="login-state-t">登录成功</div>' +
      '<div class="login-state-s">正在为你跳转…</div>' +
    '</div>';
  }

  function expiredHTML() {
    return '<div class="login-state">' +
      '<span class="login-alert">' + ic('i-alert') + '</span>' +
      '<div class="login-state-t">授权已过期</div>' +
      '<button class="btn btn-primary" data-act="login-retry">重新获取</button>' +
    '</div>';
  }

  function bodyHTML() {
    if (step === 'starting') return startingHTML();
    if (step === 'success') return successHTML();
    if (step === 'expired') return expiredHTML();
    return codeHTML();
  }

  function render() {
    var body = document.querySelector('[data-login-body]');
    if (body) body.innerHTML = bodyHTML();
  }

  /* --------------------------- transitions ------------------------------ */
  function enterCode() {
    tStart = null;
    step = 'code';
    render();
    tickId = setInterval(function () {
      remaining--;
      if (remaining <= 0) {
        clearInterval(tickId); tickId = null;
        remaining = 0;
        step = 'expired';
        render();
        return;
      }
      var el = document.querySelector('[data-login-countdown]');
      if (el) el.textContent = fmt(remaining);
    }, 1000);
  }

  function begin() {
    clearTimers();
    step = 'starting';
    remaining = START_SECONDS;
    authorizing = false;
    render();
    tStart = setTimeout(enterCode, 600);
  }

  function authorize() {
    if (step !== 'code' || authorizing) return;
    authorizing = true;
    if (tickId) { clearInterval(tickId); tickId = null; }
    tSuccess = setTimeout(function () {
      tSuccess = null;
      step = 'success';
      render();
      tClose = setTimeout(function () {
        tClose = null;
        authorizing = false;
        KP().closeOverlays();
        KP().toast('登录成功（stub）', 'success');
      }, 1000);
    }, 1000);
  }

  function open() {
    begin();
    KP().openOverlay('login');
  }

  /* ----------------------------- mount ---------------------------------- */
  function mount() {
    var host = document.getElementById('feature-mount');
    if (!host || host.querySelector('[data-overlay="login"]')) return;
    host.insertAdjacentHTML('beforeend', skeleton());
    var overlay = host.querySelector('[data-overlay="login"]');
    if (overlay && window.MutationObserver) {
      new MutationObserver(function () {
        if (!overlay.classList.contains('is-open')) clearTimers();
      }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }
  }

  /* --------------------------- self-wire -------------------------------- */
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-open-login]')) { open(); return; }
    var act = e.target.closest('[data-act]');
    if (!act) return;
    switch (act.getAttribute('data-act')) {
      case 'login-authorize': authorize(); return;
      case 'login-copy': KP().toast('已复制'); return;
      case 'login-retry': begin(); return;
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.KP_openLogin = open;
})();
