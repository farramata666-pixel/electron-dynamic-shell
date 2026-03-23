(function() {
  'use strict';

  var cfg = window.__blurSettings || { enabled: true, blurAmount: 20, gray: false };
  var B        = 'data-hb-b';
  var MIN_PX   = 40;
  var STYLE_ID = '__hb_css';

  // ── Re-injection: just update settings and re-apply, no re-init ──────────
  if (window.__hbInjected) {
    window.__hbUpdateSettings(cfg);
    return;
  }
  window.__hbInjected = true;

  // ── CSS ───────────────────────────────────────────────────────────────────

  function applyCSS() {
    var s = document.getElementById(STYLE_ID);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(s);
    }
    if (!cfg.enabled) { s.textContent = ''; return; }
    var amt = cfg.blurAmount || 20;
    var f = cfg.gray
      ? 'blur(' + amt + 'px) grayscale(100%)'
      : 'blur(' + amt + 'px)';
    s.textContent =
      '[' + B + ']{filter:' + f + '!important;transition:filter 0.25s ease!important;cursor:pointer!important;}' +
      '[' + B + ']:hover{filter:none!important;transition:filter 0.4s ease 0.15s!important;}';
  }

  // ── Eligibility ───────────────────────────────────────────────────────────

  function getSize(el) {
    if (el.tagName === 'IMG')
      return { w: el.naturalWidth  || el.width  || el.clientWidth  || 0,
               h: el.naturalHeight || el.height || el.clientHeight || 0 };
    if (el.tagName === 'VIDEO')
      return { w: el.videoWidth  || el.clientWidth  || 0,
               h: el.videoHeight || el.clientHeight || 0 };
    return { w: 0, h: 0 };
  }

  function eligible(el) {
    if (el.hasAttribute(B)) return false;
    var sz = getSize(el);
    return sz.w >= MIN_PX && sz.h >= MIN_PX;
  }

  // ── Blur / unblur ─────────────────────────────────────────────────────────

  function blurEl(el) {
    if (!cfg.enabled) return;
    if (el.tagName === 'IMG' && !el.complete) {
      el.addEventListener('load', function() { blurEl(el); }, { once: true });
      return;
    }
    if (eligible(el)) el.setAttribute(B, '1');
  }

  function unblurAll() {
    document.querySelectorAll('[' + B + ']').forEach(function(el) {
      el.removeAttribute(B);
    });
  }

  function scan(root) {
    if (!cfg.enabled || !root) return;
    var els = [];
    try { if (root.querySelectorAll) els = Array.from(root.querySelectorAll('img, video')); } catch(e) {}
    if (root.tagName === 'IMG' || root.tagName === 'VIDEO') els.push(root);
    els.forEach(blurEl);
  }

  // ── Settings update — called on re-injection AND via preload IPC ──────────

  window.__hbUpdateSettings = function(s) {
    cfg = s;
    applyCSS();
    if (!cfg.enabled) {
      unblurAll();
    } else {
      scan(document.body);
    }
  };

  // ── MutationObserver ──────────────────────────────────────────────────────

  new MutationObserver(function(mutations) {
    if (!cfg.enabled) return;
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(n) {
        if (n.nodeType !== 1) return;
        if (n.tagName === 'IMG' || n.tagName === 'VIDEO') blurEl(n);
        else if (n.querySelectorAll) scan(n);
      });
      if (m.type === 'attributes' && m.attributeName === 'src') {
        var el = m.target;
        if (el.tagName === 'IMG' || el.tagName === 'VIDEO') {
          el.removeAttribute(B);
          blurEl(el);
        }
      }
    });
  }).observe(document.documentElement, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['src']
  });

  // ── Initial run ───────────────────────────────────────────────────────────

  applyCSS();
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', function() { scan(document.body); });
  else
    scan(document.body);

})();
