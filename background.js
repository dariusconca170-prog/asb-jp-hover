'use strict';

/* JP Subtitle Hover - background service worker
 * Owns the API key, the per-line analysis cache (memory + IndexedDB) and the
 * rate gate. The content script never talks to the network directly.
 */

const DEFAULTS = {
  enabled: true,
  delay: 120,
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'openai/gpt-oss-120b',
  apiKey: ''
};

const SETTINGS_KEY = 'jpsh_settings';
const WINDOW_MS = 55 * 1000;
const MAX_REQ_PER_WINDOW = 28; // stay under Groq free tier's 30 RPM
const MEM_MAX = 400;
const DB_NAME = 'jpsh';
const STORE = 'analysis';
const KEEP_MS = 60 * 24 * 60 * 60 * 1000;

const memCache = new Map();
const inflight = new Map();
const requestTimes = [];
let writes = 0;

/* ------------------------------- settings -------------------------------- */

async function getSettings() {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULTS, ...(got[SETTINGS_KEY] || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: current });
});

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
}

/* --------------------------------- utils --------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + ':' + text.length;
}

function memPut(key, data) {
  memCache.set(key, data);
  if (memCache.size > MEM_MAX) {
    const oldest = memCache.keys().next();
    if (!oldest.done) memCache.delete(oldest.value);
  }
}

/* ------------------------------- IndexedDB -------------------------------- */

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
    }).catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

async function idbGet(key) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbPut(record) {
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    if (++writes % 100 === 0) await idbPrune();
  } catch {
    /* cache is best-effort */
  }
}

async function idbPrune() {
  try {
    const d = await db();
    const cutoff = Date.now() - KEEP_MS;
    await new Promise((resolve) => {
      const tx = d.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        if (!cur.value || !cur.value.ts || cur.value.ts < cutoff) cur.delete();
        cur.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

/* ------------------------------ rate limiting ----------------------------- */

async function gate() {
  for (let i = 0; i < 40; i++) {
    const now = Date.now();
    while (requestTimes.length && now - requestTimes[0] > WINDOW_MS) requestTimes.shift();
    if (requestTimes.length < MAX_REQ_PER_WINDOW) {
      requestTimes.push(now);
      return true;
    }
    const wait = Math.min(WINDOW_MS - (now - requestTimes[0]) + 25, 5000);
    await sleep(Math.max(250, wait));
  }
  return false;
}

/* --------------------------------- prompt --------------------------------- */

const SYSTEM_PROMPT = [
  'You analyse Japanese subtitle lines for a hover dictionary used by an English-speaking learner.',
  'Return ONLY a JSON object, no markdown, no commentary, with this exact shape:',
  '{"tokens":[{"s":0,"e":3,"w":"日本語","r":"にほんご","l":"日本語","p":"noun","g":["Japanese language","Japanese"]}],"translation":"..."}',
  '',
  'Rules:',
  '- Segment the line into words exactly as they appear. Split particles, auxiliaries and inflections into their own tokens.',
  '- s = start index in the original line, e = end index (exclusive), counted in JavaScript string characters.',
  '- Count whitespace and newline characters too: the line may contain indentation. Offsets must match the string exactly.',
  '- w = the exact substring text.slice(s, e). Never invent or normalise characters.',
  '- r = reading in hiragana. For katakana words give the katakana reading. Empty string for latin, digits and punctuation.',
  '- l = dictionary form in Japanese. For inflected verbs and adjectives give the plain dictionary form.',
  '- p = part of speech, one of: noun, pronoun, verb, i-adjective, na-adjective, adverb, particle, conjunction, interjection, counter, auxiliary, prefix, suffix, expression, numeral, latin, punctuation.',
  '- g = 1-3 short English glosses, most contextually likely sense FIRST. If it is a proper name, give the name and say it is a name.',
  '- Tokens must be sorted by s, non-overlapping, and cover every Japanese character of the line.',
  '- Glosses are English only. Never put Japanese in g except a romaji-free proper name.',
  '- translation = an accurate, natural English translation of the whole line in context. Keep names romanised.',
  '- If the line is not Japanese or is unintelligible, return {"tokens":[],"translation":""}.'
].join('\n');

function buildBody(text, s) {
  return {
    model: s.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ line: text }) }
    ],
    temperature: 0,
    max_tokens: 1600,
    reasoning_effort: 'low',
    response_format: { type: 'json_object' }
  };
}

/* ------------------------------- HTTP layer ------------------------------- */

function httpHint(status) {
  if (status === 401 || status === 403) return 'API key rejected (' + status + '). Check the key in the extension options.';
  if (status === 429) return 'Rate limited (429). Too many lookups per minute.';
  if (status === 404) return 'Model or endpoint not found (404). Check the model name and base URL in options.';
  if (status >= 500) return 'Provider error (' + status + '). Try again in a moment.';
  return 'Request failed (' + status + ').';
}

function parseRetryAfter(res) {
  const raw = res.headers.get('retry-after');
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.max(500, Math.min(secs * 1000, 20000));
  }
  return 0;
}

async function postOnce(body, s) {
  const base = String(s.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + String(s.apiKey || '').trim()
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error('Network error reaching ' + base + ': ' + ((e && e.message) || e));
    err.status = 0;
    throw err;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let detail = String(raw || '').slice(0, 300);
    try {
      const j = JSON.parse(raw);
      if (j && j.error) detail = typeof j.error === 'string' ? j.error : j.error.message || detail;
    } catch {
      /* keep raw */
    }
    const err = new Error(httpHint(res.status) + (detail ? ' — ' + detail : ''));
    err.status = res.status;
    err.retryAfterMs = parseRetryAfter(res);
    throw err;
  }

  return res.json();
}

async function post(body, s) {
  let attempt = 0;
  for (;;) {
    try {
      return await postOnce(body, s);
    } catch (e) {
      const transient = e.status === 0 || e.status === 429 || (e.status >= 500 && e.status <= 599);
      if (transient && attempt < 2) {
        const wait = e.retryAfterMs || 1200 * Math.pow(2, attempt);
        await sleep(Math.min(wait, 8000));
        attempt++;
        continue;
      }
      throw e;
    }
  }
}

async function postWithFallback(body, s) {
  try {
    return await post(body, s);
  } catch (e) {
    if (e.status !== 400) throw e;
    const b2 = { ...body };
    delete b2.reasoning_effort;
    try {
      return await post(b2, s);
    } catch (e2) {
      if (e2.status !== 400) throw e2;
      const b3 = { ...b2 };
      delete b3.response_format;
      return await post(b3, s);
    }
  }
}

/* ------------------------------- normalising ------------------------------ */

function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, max);
}

function nearestOccurrence(text, needle, near) {
  if (!needle) return -1;
  let best = -1;
  let bestDist = Infinity;
  let idx = text.indexOf(needle);
  while (idx >= 0) {
    const d = Math.abs(idx - near);
    if (d < bestDist) {
      bestDist = d;
      best = idx;
    }
    idx = text.indexOf(needle, idx + 1);
  }
  return best >= 0 && bestDist <= needle.length + 6 ? best : -1;
}

function normalize(raw, text) {
  const out = { tokens: [], translation: '' };
  if (!raw || typeof raw !== 'object') return out;
  const list = Array.isArray(raw.tokens) ? raw.tokens : [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    let s = Math.trunc(Number(t.s));
    let e = Math.trunc(Number(t.e));
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    s = Math.max(0, Math.min(s, text.length));
    e = Math.max(0, Math.min(e, text.length));
    if (e <= s) continue;
    let surface = cleanStr(t.w, 60);
    const slice = text.slice(s, e);
    if (surface && slice.replace(/\s+/g, ' ').trim() !== surface) {
      // Offsets and surface text disagree: re-align so the popup highlights the
      // word the model actually described instead of a shifted one.
      const at = nearestOccurrence(text, surface, s);
      if (at >= 0) {
        s = at;
        e = at + surface.length;
      } else {
        surface = slice.trim();
      }
    } else if (!surface) {
      surface = slice.trim();
    }
    if (!surface || e <= s) continue;
    const glosses = Array.isArray(t.g)
      ? t.g.map((g) => cleanStr(g, 120)).filter(Boolean).slice(0, 4)
      : typeof t.g === 'string'
        ? [cleanStr(t.g, 120)].filter(Boolean)
        : [];
    out.tokens.push({
      s,
      e,
      w: surface,
      r: cleanStr(t.r, 60),
      l: cleanStr(t.l, 60),
      p: cleanStr(t.p, 40),
      g: glosses
    });
  }
  out.tokens.sort((a, b) => a.s - b.s || b.e - a.e);
  // Drop exact duplicates: they would make tokenAt() return an arbitrary twin.
  out.tokens = out.tokens.filter((t, i, all) => i === 0 || t.s !== all[i - 1].s || t.e !== all[i - 1].e);
  out.translation = cleanStr(raw.translation, 600);
  if (raw.note) out.note = cleanStr(raw.note, 200);
  return out;
}

function parseContent(content, text) {
  let s = String(content || '').trim();
  if (!s) throw new Error('Model returned an empty response.');
  if (s.startsWith('```')) s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('Model did not return JSON. Try again or switch model.');
    obj = JSON.parse(s.slice(a, b + 1));
  }
  return normalize(obj, text);
}

/* -------------------------------- analysis -------------------------------- */

async function analyze(rawText) {
  // Keep the line EXACTLY as the content script sees it: token offsets returned by
  // the model are indices into this string, so any normalisation would shift them.
  const text = String(rawText || '').slice(0, 400);
  if (!text.trim()) throw new Error('Empty subtitle line.');

  const key = hashText(text);
  const cached = memCache.get(key);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const stored = await idbGet(key);
    if (stored && stored.text === text && stored.data) {
      memPut(key, stored.data);
      return stored.data;
    }
    const s = await getSettings();
    if (!s.apiKey) {
      throw new Error('No API key set. Click the extension icon (or chrome://extensions → details → Extension options) and paste a Groq API key.');
    }
    const allowed = await gate();
    if (!allowed) throw new Error('Too many subtitle lookups in the last minute. Wait a few seconds and hover again.');
    const res = await postWithFallback(buildBody(text, s), s);
    const content = res && res.choices && res.choices[0] && res.choices[0].message
      ? res.choices[0].message.content
      : '';
    const data = parseContent(content, text);
    memPut(key, data);
    idbPut({ key, text, data, ts: Date.now() });
    return data;
  })();

  inflight.set(key, job);
  job.then(
    () => inflight.delete(key),
    () => inflight.delete(key)
  );
  return job;
}

/* -------------------------------- messaging ------------------------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'jpsh:analyze') return undefined;
  analyze(msg.text).then(
    (data) => sendResponse({ data }),
    (err) => sendResponse({ error: (err && err.message) || String(err) })
  );
  return true;
});
