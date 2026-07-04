/* Kimi Code Web prototype — feature module: model picker.
   Self-contained. Reads helpers from window.KP (set by app.js) and
   injects its overlay into #feature-mount. Wires its own document listeners. */
(function () {
  'use strict';

  function kp() { return window.KP || {}; }
  function S() { return kp().Store; }
  function esc(s) { return kp().esc ? kp().esc(s) : String(s); }
  function icon(id, cls) { return kp().icon ? kp().icon(id, cls) : ''; }

  /* i-star is not in the sprite; fall back to i-check per spec. */
  var starGlyph = null;
  function starIcon() {
    if (starGlyph) return starGlyph;
    starGlyph = document.getElementById('i-star') ? 'i-star' : 'i-check';
    return starGlyph;
  }

  /* ----------------------------- overlay -------------------------------- */
  function ensureOverlay() {
    if (document.querySelector('[data-overlay="models"]')) return;
    var mount = document.getElementById('feature-mount');
    if (!mount) return;
    var h =
      '<div class="overlay" data-overlay="models">' +
        '<section class="modal search-modal" role="dialog" aria-modal="true" aria-label="选择模型">' +
          '<div class="field" style="margin:0">' +
            icon('i-search') +
            '<input data-mp-search type="search" placeholder="搜索模型…" autocomplete="off">' +
          '</div>' +
          '<ul data-mp-list></ul>' +
        '</section>' +
      '</div>';
    mount.insertAdjacentHTML('beforeend', h);
  }

  /* ----------------------------- data ----------------------------------- */
  function currentProvider() {
    var store = S();
    var m = store.model(store.state.modelId);
    return m ? m.provider : null;
  }

  function matches(m, q) {
    if (!q) return true;
    return m.name.toLowerCase().indexOf(q) !== -1 ||
      m.provider.toLowerCase().indexOf(q) !== -1;
  }

  function rowHTML(m) {
    var store = S();
    var cur = m.id === store.state.modelId;
    var lead = cur ? icon('i-check') : '';
    var badge = m.thinking !== 'off' ? '<span class="badge neutral">thinking</span>' : '';
    var starCls = 'ic-btn mp-star' + (m.starred ? ' on' : '');
    return '<li><div class="mi mp-row" data-mp-row data-id="' + m.id + '" role="button" tabindex="0">' +
      '<span class="mp-lead">' + lead + '</span>' +
      '<span class="mp-name">' + esc(m.name) + '</span>' +
      badge +
      '<button class="' + starCls + '" data-mp-star data-id="' + m.id + '" aria-label="星标" aria-pressed="' + (m.starred ? 'true' : 'false') + '">' + icon(starIcon()) + '</button>' +
    '</div></li>';
  }

  /* ----------------------------- render --------------------------------- */
  function renderList(q) {
    var list = document.querySelector('[data-mp-list]');
    if (!list) return;
    var store = S();
    var query = (q || '').trim().toLowerCase();
    var curProv = currentProvider();

    var models = store.models.filter(function (m) { return matches(m, query); });

    var starred = models.filter(function (m) {
      return m.starred && m.provider !== curProv;
    });

    // providers present among the (filtered) models, sorted
    var providers = [];
    models.forEach(function (m) {
      if (providers.indexOf(m.provider) === -1) providers.push(m.provider);
    });
    providers.sort();

    var h = '';
    if (starred.length) {
      h += '<li class="mp-group">星标</li>';
      starred.forEach(function (m) { h += rowHTML(m); });
    }
    providers.forEach(function (p) {
      h += '<li class="mp-group">' + esc(p.toUpperCase()) + '</li>';
      models.forEach(function (m) { if (m.provider === p) h += rowHTML(m); });
    });

    if (!h) {
      h = '<li class="mp-empty">没有匹配的模型</li>';
    }
    list.innerHTML = h;
  }

  function currentQuery() {
    var inp = document.querySelector('[data-mp-search]');
    return inp ? inp.value : '';
  }

  /* ----------------------------- actions -------------------------------- */
  function select(id) {
    var store = S();
    var m = store.model(id);
    if (!m) return;
    store.set({ modelId: id });
    if (kp().closeOverlays) kp().closeOverlays();
    var label = document.querySelector('[data-model-label]');
    if (label) {
      label.textContent = m.name + (m.thinking !== 'off' ? ' · thinking' : '');
    }
  }

  function toggleStar(id) {
    var store = S();
    var m = store.model(id);
    if (!m) return;
    m.starred = !m.starred;          // mutate the item in Store.models
    renderList(currentQuery());      // re-render, do not close
  }

  function open() {
    ensureOverlay();
    if (kp().openOverlay) kp().openOverlay('models');
    renderList('');
    var inp = document.querySelector('[data-mp-search]');
    if (inp) {
      inp.value = '';
      setTimeout(function () { inp.focus(); }, 0);
    }
  }

  /* ----------------------------- wiring --------------------------------- */
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-open-models]')) { open(); return; }

    var star = e.target.closest('[data-mp-star]');
    if (star) {
      e.preventDefault();
      toggleStar(star.getAttribute('data-id'));
      return;
    }

    var row = e.target.closest('[data-mp-row]');
    if (row) { select(row.getAttribute('data-id')); return; }
  });

  document.addEventListener('input', function (e) {
    if (e.target.matches('[data-mp-search]')) renderList(e.target.value);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var row = e.target.closest && e.target.closest('[data-mp-row]');
    if (row) { e.preventDefault(); select(row.getAttribute('data-id')); }
  });

  /* ----------------------------- entry ---------------------------------- */
  window.KP_openModels = open;

  // Inject once at load so openOverlay('models') works from anywhere.
  if (document.body) ensureOverlay();
  else document.addEventListener('DOMContentLoaded', ensureOverlay);
})();
