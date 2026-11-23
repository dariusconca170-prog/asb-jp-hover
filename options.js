'use strict';

const DEFAULTS = {
  enabled: true,
  delay: 120,
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'openai/gpt-oss-120b',
  apiKey: ''
};

const SETTINGS_KEY = 'jpsh_settings';
const SAMPLE = 'ずっと一緒にいたいんだ。';

const $ = (id) => document.getElementById(id);
const fields = {
  apiKey: $('apiKey'),
  baseUrl: $('baseUrl'),
  model: $('model'),
  delay: $('delay'),
  enabled: $('enabled')
};

function setStatus(text) {
  $('status').textContent = text || '';
}

function fill(settings) {
  fields.apiKey.value = settings.apiKey || '';
  fields.baseUrl.value = settings.baseUrl || DEFAULTS.baseUrl;
  fields.model.value = settings.model || DEFAULTS.model;
  fields.delay.value = Number.isFinite(Number(settings.delay)) ? Number(settings.delay) : DEFAULTS.delay;
  fields.enabled.checked = settings.enabled !== false;
}

function read() {
  const delay = Number(fields.delay.value);
  return {
    apiKey: fields.apiKey.value.trim(),
    baseUrl: fields.baseUrl.value.trim() || DEFAULTS.baseUrl,
    model: fields.model.value.trim() || DEFAULTS.model,
    delay: Number.isFinite(delay) ? Math.max(0, Math.min(600, delay)) : DEFAULTS.delay,
    enabled: fields.enabled.checked
  };
}

async function load() {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    fill({ ...DEFAULTS, ...((got && got[SETTINGS_KEY]) || {}) });
  } catch {
    fill(DEFAULTS);
  }
}

async function save() {
  const settings = read();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  setStatus('Saved.');
  setTimeout(() => setStatus(''), 1800);
}

async function test() {
  const out = $('out');
  out.textContent = 'Sending sample lookup…';
  setStatus('');
  await save();
  try {
    const res = await chrome.runtime.sendMessage({ type: 'jpsh:analyze', text: SAMPLE });
    if (!res) {
      out.textContent = 'No response from the background worker.';
      return;
    }
    if (res.error) {
      out.textContent = 'Error: ' + res.error;
      return;
    }
    const lines = [SAMPLE, ''];
    for (const t of res.data.tokens || []) {
      const reading = t.r ? ' [' + t.r + ']' : '';
      const gloss = (t.g || []).join('; ');
      lines.push(t.w + reading + ' — ' + gloss);
    }
    if (res.data.translation) lines.push('', 'EN: ' + res.data.translation);
    out.textContent = lines.join('\n');
  } catch (e) {
    out.textContent = 'Error: ' + ((e && e.message) || e);
  }
}

$('save').addEventListener('click', () => {
  save().catch((e) => setStatus('Save failed: ' + ((e && e.message) || e)));
});
$('test').addEventListener('click', () => {
  test().catch((e) => {
    $('out').textContent = 'Error: ' + ((e && e.message) || e);
  });
});
fields.apiKey.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  save().catch((err) => setStatus('Save failed: ' + ((err && err.message) || err)));
});

load();
