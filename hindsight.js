#!/usr/bin/env node
'use strict';

const fs = require('fs');

const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || '/var/lib/openclaw/.openclaw/openclaw.json';

function loadOpenClawMemorySearch() {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
    return cfg?.agents?.defaults?.memorySearch || {};
  } catch {
    return {};
  }
}

function loadHindsightConfig() {
  const ms = loadOpenClawMemorySearch();
  return {
    baseUrl: process.env.HINDSIGHT_BASE_URL || 'http://127.0.0.1:8888',
    bankId: process.env.HINDSIGHT_BANK_ID || 'openclaw-main',
    enabled: process.env.HINDSIGHT_ENABLED !== '0',
    embedModel: process.env.LAYER2_EMBED_MODEL || ms?.model || 'BAAI/bge-m3',
    embedBaseUrl: process.env.LAYER2_EMBED_BASE_URL || ms?.remote?.baseUrl || 'https://api.siliconflow.cn/v1',
    embedApiKey: process.env.LAYER2_EMBED_API_KEY || ms?.remote?.apiKey || '',
  };
}

async function hcFetch(path, options = {}) {
  const cfg = loadHindsightConfig();
  const base = cfg.baseUrl.replace(/\/$/, '');
  const urlStr = `${base}${path}`;
  let parsed;
  try { parsed = new URL(urlStr); } catch { parsed = { hostname: '127.0.0.1', port: '8888', pathname: path, search: '' }; }
  const lib = (parsed.protocol === 'https:') ? require('https') : require('http');
  const timeoutMs = Math.min(Number(process.env.HINDSIGHT_TIMEOUT_MS || 3000), 3000);
  const method = (options || {}).method || 'GET';
  const headers = (options || {}).headers || {};
  const body = (options || {}).body || null;

  return new Promise(resolve => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const req = lib.request({
      hostname: parsed.hostname || '127.0.0.1',
      port:    parsed.port    || '8888',
      path:    (parsed.pathname || '') + (parsed.search || ''),
      method,
      headers,
      timeout: timeoutMs,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* noop */ }
        done({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: data, json });
      });
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, status: 0, detail: 'hindsight http timeout' }); });
    req.on('error', e  => done({ ok: false, status: 0, detail: e.message }));
    if (body) req.write(body);
    req.end();
    setTimeout(() => { if (!settled) { req.destroy(); done({ ok: false, status: 0, detail: 'hindsight max-wait exceeded' }); } }, timeoutMs + 200);
  });
}

async function healthcheck() {
  const cfg = loadHindsightConfig();
  console.error('[hindsight] healthcheck:start', JSON.stringify({ baseUrl: cfg.baseUrl, bankId: cfg.bankId }));
  if (!cfg.enabled) return { ok: false, detail: 'HINDSIGHT_ENABLED=0' };
  try {
    const r = await hcFetch('/health');
    console.error('[hindsight] healthcheck:/health', JSON.stringify({ ok: r.ok, status: r.status }));
    if (r.ok) return { ok: true, detail: 'health endpoint reachable' };
  } catch {}
  try {
    const r = await hcFetch('/');
    console.error('[hindsight] healthcheck:/', JSON.stringify({ ok: r.ok, status: r.status }));
    if (r.ok || r.status < 500) return { ok: true, detail: `root reachable (${r.status})` };
    return { ok: false, detail: `HTTP ${r.status}` };
  } catch (e) {
    console.error('[hindsight] healthcheck:error', e?.name || 'Error', e?.message || String(e));
    return { ok: false, detail: e?.message || String(e) };
  }
}

async function ensureBank() {
  const cfg = loadHindsightConfig();
  console.error('[hindsight] ensureBank:start', JSON.stringify({ bankId: cfg.bankId }));
  const body = JSON.stringify({ reflect_mission: 'Layer2 advanced memory bank for OpenClaw recall and reflection' });
  return hcFetch(`/v1/default/banks/${encodeURIComponent(cfg.bankId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
}

async function recall(query, { topK = 5 } = {}) {
  const cfg = loadHindsightConfig();
  console.error('[hindsight] recall:start', JSON.stringify({ bankId: cfg.bankId, topK, query: String(query).slice(0,80) }));
  await ensureBank();
  const body = JSON.stringify({ query, max_tokens: 4096, budget: 'mid' });
  const path = `/v1/default/banks/${encodeURIComponent(cfg.bankId)}/memories/recall`;
  try {
    const r = await hcFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (r.ok) return { ok: true, data: r.json || r.text, endpoint: path };
    return { ok: false, error: `${r.status}: ${String(r.text).slice(0,200)}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function reflect(query) {
  const cfg = loadHindsightConfig();
  console.error('[hindsight] reflect:start', JSON.stringify({ bankId: cfg.bankId, query: String(query).slice(0,80) }));
  await ensureBank();
  const body = JSON.stringify({ query, include: { facts: {} }, max_tokens: 1024, budget: 'low' });
  const path = `/v1/default/banks/${encodeURIComponent(cfg.bankId)}/reflect`;
  try {
    const r = await hcFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (r.ok) return { ok: true, data: r.json || r.text, endpoint: path };
    return { ok: false, error: `${r.status}: ${String(r.text).slice(0,200)}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}



async function retain(content, metadata = {}) {
  const cfg = loadHindsightConfig();
  await ensureBank();
  const body = JSON.stringify({
    items: [{ content, metadata, context: metadata.context || null }],
    async: false
  });
  const path = `/v1/default/banks/${encodeURIComponent(cfg.bankId)}/memories`;
  try {
    const r = await hcFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (r.ok) return { ok: true, data: r.json || r.text, endpoint: path };
    return { ok: false, error: `${r.status}: ${String(r.text).slice(0,200)}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { loadHindsightConfig, healthcheck, ensureBank, recall, reflect, retain };
