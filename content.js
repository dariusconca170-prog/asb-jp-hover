(() => {
  'use strict';

  /* JP Subtitle Hover - content script
   *
   * Stability rules baked in:
   *  - one popup element, reused, inside a closed-style shadow root (no page CSS bleed)
   *  - every show carries a sequence number; stale async results are discarded
   *  - hides on: grace timeout (pointer leaves word and popup), Escape, outside
   *    pointerdown, scroll, resize, tab hidden, window blur, subtitle text change
   *  - pointer over the popup always cancels a pending hide
   *  - popup position is clamped to the viewport after measuring
   */

  if (window.__jpshLoaded) return;
  window.__jpshLoaded = true;

  const HOST_ID = 'jpsh-popup-host';
  const HIDE_GRACE = 220;
  const MAX_LINE = 120;
  const JP_CHAR = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;
  const DEFAULTS = { enabled: true, delay: 120 };

  const CSS = `
    .jpsh-body {
      position: fixed;
      box-sizing: border-box;
      max-width: min(360px, calc(100vw - 16px));
      max-height: min(55vh, 400px);
      overflow: auto;
      padding: 9px 12px 10px;
      border-radius: 10px;
      background: rgba(16, 18, 23, 0.97);
      color: #edf1f7;
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
      text-align: left;
      letter-spacing: 0;
      white-space: normal;
      pointer-events: auto;
      user-select: text;
      cursor: auto;
      display: none;
    }
    .jpsh-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 6px; }
    .jpsh-word { font-size: 20px; font-weight: 650; line-height: 1.25; }
    .jpsh-reading { font-size: 12px; font-weight: 500; color: #8ad3ff; }
    .jpsh-pos { margin-top: 1px; font-size: 11px; color: #9aa5b4; }
    .jpsh-gloss { margin: 6px 0 0; padding: 0; list-style: none; }
    .jpsh-gloss li { position: relative; margin: 0 0 2px 12px; }
    .jpsh-gloss li::before { content: "•"; position: absolute; left: -11px; color: #6ba6ff; }
    .jpsh-sentence { margin-top: 8px; padding-top: 7px; border-top: 1px solid rgba(255, 255, 255, 0.1); font-size: 12px; color: #bcc6d4; }
    .jpsh-note { margin-top: 6px; font-size: 11px; color: #7d8797; }
    .jpsh-loading { font-size: 12px; color: #9aa5b4; }
    .jpsh-error { font-size: 12px; color: #ff9d9d; max-width: 320px; }
  `;

  let settings = { ...DEFAULTS };
  let host = null;
  let shadow = null;
  let card = null;

  let hideTimer = 0;
  let hoverTimer = 0;
  let mutationTimer = 0;
  let moveRaf = 0;
  let seq = 0;
  let visible = false;

  const pointer = { x: -1, y: -1 };
  let target = { lineEl: null, text: '', offset: -1 };
  let charCache = null;
  const dataCache = new Map();
  const pending = new Map();

  /* ------------------------------ settings ------------------------------- */

  function applySettings(raw) {
    const s = raw || {};
    const delay = Number(s.delay);
    settings = {
      enabled: s.enabled !== false,
      delay: Number.isFinite(delay) ? Math.max(0, Math.min(600, delay)) : DEFAULTS.delay
    };
    if (!settings.enabled) hideNow();
  }

  try {
    chrome.storage.local.get('jpsh_settings').then((g) => applySettings(g && g.jpsh_settings)).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.jpsh_settings) return;
      applySettings(changes.jpsh_settings.newValue);
    });
  } catch {
    /* extension context gone */
  }

  /* ------------------------------ popup DOM ------------------------------ */

  function ensurePopup() {
    if (host && host.isConnected && card && shadow) return true;
    try {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText =
        'all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; ' +
        'overflow: visible; z-index: 2147483647; pointer-events: none;';
      shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      card = document.createElement('div');
      card.className = 'jpsh-body';
      card.addEventListener('pointerenter', () => {
        clearTimeout(hideTimer);
        hideTimer = 0;
      });
      card.addEventListener('pointerleave', () => scheduleHide(HIDE_GRACE));
      card.addEventListener('pointerdown', (e) => e.stopPropagation());
      shadow.append(style, card);
      (document.body || document.documentElement).appendChild(host);
      return true;
    } catch {
      host = null;
      shadow = null;
      card = null;
      return false;
    }
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function buildCard(data, token, text) {
    const root = el('div', 'jpsh-inner');
    const head = el('div', 'jpsh-head');
    const surface = String(token.w || text.slice(token.s, token.e) || '').trim() || '—';
    head.appendChild(el('span', 'jpsh-word', surface));
    const reading = String(token.r || '').trim();
    if (reading && reading !== surface) head.appendChild(el('span', 'jpsh-reading', reading));
    root.appendChild(head);

    const meta = [];
    const lemma = String(token.l || '').trim();
    if (lemma && lemma !== surface) meta.push('lemma ' + lemma);
    if (token.p) meta.push(String(token.p));
    if (meta.length) root.appendChild(el('div', 'jpsh-pos', meta.join(' · ')));

    const glosses = Array.isArray(token.g) ? token.g.filter((g) => typeof g === 'string' && g.trim()) : [];
    if (glosses.length) {
      const ul = el('ul', 'jpsh-gloss');
      for (const g of glosses.slice(0, 4)) ul.appendChild(el('li', null, g));
      root.appendChild(ul);
    }

    const translation = String((data && data.translation) || '').trim();
    if (translation) root.appendChild(el('div', 'jpsh-sentence', translation));
    if (data && data.note) root.appendChild(el('div', 'jpsh-note', data.note));
    return root;
  }

  function positionCard(anchor) {
    if (!card) return;
    card.style.display = 'block';
    card.style.left = '0px';
    card.style.top = '0px';
    const r = card.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const pad = 8;
    const gap = 10;

    let left;
    if (anchor) left = anchor.left + anchor.width / 2 - r.width / 2;
    else left = pointer.x - r.width / 2;
    left = Math.max(pad, Math.min(left, Math.max(pad, vw - r.width - pad)));

    let top;
    if (anchor && anchor.top - r.height - gap >= pad) top = anchor.top - r.height - gap;
    else if (anchor && anchor.bottom + gap + r.height <= vh - pad) top = anchor.bottom + gap;
    else if (anchor) top = anchor.top - r.height - gap;
    else top = pointer.y - r.height - gap;
    top = Math.max(pad, Math.min(top, Math.max(pad, vh - r.height - pad)));

    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
  }

  function showCard(node, anchor) {
    if (!ensurePopup()) return;
    card.textContent = '';
    card.appendChild(node);
    visible = true;
    positionCard(anchor);
  }

  function hideNow() {
    clearTimeout(hideTimer);
    clearTimeout(hoverTimer);
    hideTimer = 0;
    hoverTimer = 0;
    seq++;
    visible = false;
    target = { lineEl: null, text: '', offset: -1 };
    if (card) {
      card.style.display = 'none';
      card.textContent = '';
    }
  }

  function scheduleHide(ms) {
    if (!visible) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      if (pointerInsideCard()) return;
      hideNow();
    }, ms);
  }

  /* --------------------------- hit testing page text --------------------- */

  function isOurs(node) {
    if (!node) return false;
    if (node === host) return true;
    try {
      return !!shadow && node.getRootNode() === shadow;
    } catch {
      return false;
    }
  }

  function deepElementFromPoint(x, y) {
    let node = null;
    try {
      node = document.elementFromPoint(x, y);
    } catch {
      return null;
    }
    for (let i = 0; i < 10 && node && node.shadowRoot; i++) {
      let inner = null;
      try {
        inner = node.shadowRoot.elementFromPoint(x, y);
      } catch {
        break;
      }
      if (!inner || inner === node) break;
      node = inner;
    }
    return node;
  }

  function pointerInsideCard() {
    if (!visible) return false;
    return isOurs(deepElementFromPoint(pointer.x, pointer.y));
  }

  function parentOf(node) {
    return node.parentElement || (node.parentNode && node.parentNode.host) || null;
  }

  function findLine(startEl) {
    if (!startEl || startEl.nodeType !== 1) return null;
    let best = startEl;
    let node = startEl;
    for (let i = 0; i < 12; i++) {
      const p = parentOf(node);
      if (!p || p === document.body || p === document.documentElement) break;
      const t = p.textContent || '';
      if (t.trim().length === 0 || t.trim().length > MAX_LINE) break;
      best = p;
      node = p;
    }
    const text = best.textContent || '';
    if (!text.trim()) return null;
    if (text.trim().length > MAX_LINE) return null;
    return best;
  }

  function getChars(lineEl) {
    const text = lineEl.textContent || '';
    // Range rects are viewport-relative: any scroll or resize makes them stale.
    const vx = window.scrollX || 0;
    const vy = window.scrollY || 0;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (
      charCache &&
      charCache.lineEl === lineEl &&
      charCache.text === text &&
      charCache.vx === vx &&
      charCache.vy === vy &&
      charCache.vw === vw &&
      charCache.vh === vh &&
      charCache.lineEl.isConnected
    ) {
      return charCache;
    }
    const chars = new Array(text.length);
    let walker;
    try {
      walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    } catch {
      return { lineEl, text, chars, starts: new Map(), vx, vy, vw, vh };
    }
    const range = document.createRange();
    const starts = new Map();
    let node = walker.nextNode();
    let idx = 0;
    while (node) {
      const value = node.nodeValue || '';
      starts.set(node, idx);
      for (let i = 0; i < value.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const list = range.getClientRects();
        const rects = [];
        for (let k = 0; k < list.length; k++) {
          const r = list[k];
          if (r.width || r.height) {
            rects.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
          }
        }
        chars[idx + i] = rects;
      }
      idx += value.length;
      node = walker.nextNode();
    }
    charCache = { lineEl, text, chars, starts, vx, vy, vw, vh };
    return charCache;
  }

  function offsetAt(chars, x, y) {
    let nearest = -1;
    let nearestDist = 100; // squared px, ~10px tolerance
    for (let i = 0; i < chars.length; i++) {
      const rects = chars[i];
      if (!rects) continue;
      for (let k = 0; k < rects.length; k++) {
        const r = rects[k];
        if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return i;
        const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        const d = dx * dx + dy * dy;
        if (d < nearestDist) {
          nearestDist = d;
          nearest = i;
        }
      }
    }
    return nearest;
  }

  /* Caret-based lookup. Layout hit-testing still finds text that sits under an
   * overlay with pointer-events: none (asbplayer and some streaming players do
   * this), where document.elementFromPoint only ever returns the overlay. */
  function caretAt(x, y) {
    try {
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p && p.offsetNode) return { node: p.offsetNode, offset: p.offset };
      }
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r && r.startContainer) return { node: r.startContainer, offset: r.startOffset };
      }
    } catch {
      /* fall through to the element path */
    }
    return null;
  }

  function pointInRects(rects, x, y, pad) {
    for (let k = 0; k < rects.length; k++) {
      const r = rects[k];
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) return true;
    }
    return false;
  }

  function caretHit(x, y) {
    const hit = caretAt(x, y);
    if (!hit || !hit.node || hit.node.nodeType !== 3) return null;
    const node = hit.node;
    if (isOurs(node)) return null;
    const parent = node.parentElement;
    if (!parent) return null;
    const lineEl = findLine(parent);
    if (!lineEl) return null;
    const cached = getChars(lineEl);
    let base = -1;
    if (cached.starts && cached.starts.has(node)) {
      base = cached.starts.get(node);
    } else {
      base = indexOfTextNode(lineEl, node);
      if (base < 0) return null;
    }
    // The caret lands between characters, so check the neighbours and accept
    // only a glyph whose rect actually contains the pointer.
    for (let d = -2; d <= 2; d++) {
      const i = base + hit.offset + d;
      if (i < 0 || i >= cached.text.length) continue;
      const rects = cached.chars[i];
      if (!rects || !rects.length) continue;
      if (!pointInRects(rects, x, y, 2)) continue;
      const ch = cached.text[i] || '';
      if (!JP_CHAR.test(ch) && !JP_CHAR.test(cached.text)) return null;
      return { lineEl, text: cached.text, chars: cached.chars, offset: i };
    }
    return null;
  }

  function indexOfTextNode(lineEl, node) {
    let walker;
    try {
      walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    } catch {
      return -1;
    }
    let n = walker.nextNode();
    let idx = 0;
    while (n) {
      if (n === node) return idx;
      idx += (n.nodeValue || '').length;
      n = walker.nextNode();
    }
    return -1;
  }

  function hitTest(x, y, preEl) {
    // 1) layout/caret path: survives pointer-events: none overlays
    const caret = caretHit(x, y);
    if (caret) return caret;

    // 2) event-target path: exact glyph rects for ordinary page text
    const node = preEl === undefined ? deepElementFromPoint(x, y) : preEl;
    if (!node || isOurs(node)) return null;
    const lineEl = findLine(node);
    if (!lineEl) return null;
    const cached = getChars(lineEl);
    const offset = offsetAt(cached.chars, x, y);
    if (offset < 0) return null;
    const char = cached.text[offset] || '';
    if (!JP_CHAR.test(char) && !JP_CHAR.test(cached.text)) return null;
    return { lineEl, text: cached.text, chars: cached.chars, offset };
  }

  function wordAnchor(chars, s, e) {
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = s; i < e && i < chars.length; i++) {
      const rects = chars[i];
      if (!rects) continue;
      for (let k = 0; k < rects.length; k++) {
        const r = rects[k];
        if (r.left < left) left = r.left;
        if (r.right > right) right = r.right;
        if (r.top < top) top = r.top;
        if (r.bottom > bottom) bottom = r.bottom;
      }
    }
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, right, top, bottom, width: right - left, height: bottom - top };
  }

  /* ------------------------------- tokens -------------------------------- */

  function tokenAt(data, offset) {
    const tokens = data && Array.isArray(data.tokens) ? data.tokens : [];
    for (const t of tokens) {
      if (offset >= t.s && offset < t.e) return t;
    }
    let best = null;
    let bestDist = Infinity;
    for (const t of tokens) {
      const d = offset < t.s ? t.s - offset : offset - t.e + 1;
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    return bestDist <= 1 ? best : null;
  }

  function charClass(ch) {
    if (/[\u30a0-\u30ff\u30fc]/.test(ch)) return 'katakana';
    if (/[\u3040-\u309f]/.test(ch)) return 'hiragana';
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) return 'kanji';
    if (/[A-Za-z]/.test(ch)) return 'latin';
    if (/[0-9]/.test(ch)) return 'digit';
    return 'other';
  }

  function fallbackToken(text, offset) {
    const ch = text[offset] || '';
    const cls = charClass(ch);
    if (cls === 'other') return { s: offset, e: offset + 1, w: ch, r: '', l: '', p: '', g: [] };
    let s = offset;
    let e = offset + 1;
    while (s > 0 && charClass(text[s - 1]) === cls) s--;
    while (e < text.length && charClass(text[e]) === cls) e++;
    return { s, e, w: text.slice(s, e), r: '', l: '', p: '', g: [] };
  }

  /* -------------------------------- network ------------------------------ */

  function requestAnalysis(text) {
    const existing = pending.get(text);
    if (existing) return existing;
    const p = new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'jpsh:analyze', text }, (res) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error('Extension background unavailable: ' + lastError.message));
            return;
          }
          if (!res) {
            reject(new Error('No response from the extension background.'));
            return;
          }
          if (res.error) {
            reject(new Error(res.error));
            return;
          }
          resolve(res.data);
        });
      } catch (e) {
        reject(new Error('Extension context invalidated. Reload the page.'));
      }
    });
    pending.set(text, p);
    p.then(
      () => pending.delete(text),
      () => pending.delete(text)
    );
    return p;
  }

  /* ------------------------------- showing ------------------------------- */

  async function begin(info) {
    const mySeq = ++seq;
    const cached = dataCache.get(info.text);
    if (cached) paint(info, cached);
    else showCard(el('div', 'jpsh-loading', 'Looking up…'), oneCharAnchor(info));

    let data;
    try {
      data = await requestAnalysis(info.text);
    } catch (err) {
      if (mySeq !== seq) return;
      showCard(el('div', 'jpsh-error', (err && err.message) || String(err)), oneCharAnchor(info));
      return;
    }
    if (mySeq !== seq) return;
    dataCache.set(info.text, data);
    if (pointerInsideCard()) return;
    const now = hitTest(pointer.x, pointer.y);
    if (!now || now.lineEl !== info.lineEl) return;
    paint(now, data);
  }

  function oneCharAnchor(info) {
    return wordAnchor(info.chars, info.offset, info.offset + 1);
  }

  function paint(info, data) {
    const token = tokenAt(data, info.offset) || fallbackToken(info.text, info.offset);
    const anchor = wordAnchor(info.chars, token.s, token.e) || oneCharAnchor(info);
    showCard(buildCard(data, token, info.text), anchor);
  }

  /* -------------------------------- events ------------------------------- */

  function onPointerMove(e) {
    if (e.pointerType === 'touch') return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (!settings.enabled) return;
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      processMove();
    });
  }

  function processMove() {
    const x = pointer.x;
    const y = pointer.y;
    if (x < 0 || y < 0) return;
    const node = deepElementFromPoint(x, y);
    if (!settings.enabled) {
      if (visible) hideNow();
      return;
    }
    if (isOurs(node)) {
      clearTimeout(hideTimer);
      clearTimeout(hoverTimer);
      hideTimer = 0;
      hoverTimer = 0;
      return;
    }
    const info = hitTest(x, y, node);
    if (!info) {
      scheduleHide(180);
      return;
    }
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (target.lineEl === info.lineEl && target.offset === info.offset) return;

    const sameLine = target.lineEl === info.lineEl;
    target = { lineEl: info.lineEl, text: info.text, offset: info.offset };
    if (visible && !sameLine) hideNow();

    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      hoverTimer = 0;
      begin(info);
    }, settings.delay);
  }

  function onPointerDown(e) {
    if (!visible) return;
    if (isOurs(e.target) || e.composedPath().some(isOurs)) return;
    hideNow();
  }

  function onKeyDown(e) {
    if (!visible) return;
    if (e.key === 'Escape') hideNow();
  }

  function eventFromPopup(e) {
    if (!host || !e) return false;
    try {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (path.length && (path.indexOf(host) >= 0 || (shadow && path.indexOf(shadow) >= 0))) return true;
    } catch {
      /* ignore */
    }
    return isOurs(e.target);
  }

  function onViewportChange(e) {
    // Scrolling the popup itself (long gloss list) must not dismiss it.
    if (e && eventFromPopup(e)) return;
    if (visible) hideNow();
  }

  function onVisibility() {
    if (document.hidden) hideNow();
  }

  window.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('scroll', onViewportChange, { passive: true, capture: true });
  window.addEventListener('resize', onViewportChange, { passive: true });
  window.addEventListener('blur', () => scheduleHide(300));
  document.addEventListener('pointerleave', () => scheduleHide(140));
  document.addEventListener('visibilitychange', onVisibility);

  /* Keep the popup honest when the subtitle under it changes. */
  let mo = null;
  try {
    mo = new MutationObserver(() => {
      if (!visible) return;
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(() => {
        if (!visible) return;
        const node = deepElementFromPoint(pointer.x, pointer.y);
        if (isOurs(node)) return;
        if (!hitTest(pointer.x, pointer.y, node)) hideNow();
      }, 180);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  } catch {
    /* no observer: the other hide paths still cover it */
  }
})();
