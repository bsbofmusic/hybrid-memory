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
  const url = `${cfg.baseUrl.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

async function healthcheck() {
  const cfg = loadHindsightConfig();
  if (!cfg.enabled) return { ok: false, detail: 'HINDSIGHT_ENABLED=0' };
  try {
    const r = await hcFetch('/health');
    if (r.ok) return { ok: true, detail: 'health endpoint reachable' };
  } catch {}
  try {
    const r = await hcFetch('/');
    if (r.ok || r.status < 500) return { ok: true, detail: `root reachable (${r.status})` };
    return { ok: false, detail: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

async function ensureBank() {
  const cfg = loadHindsightConfig();
  const body = JSON.stringify({ reflect_mission: 'Layer2 advanced memory bank for OpenClaw recall and reflection' });
  return hcFetch(`/v1/default/banks/${encodeURIComponent(cfg.bankId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
}

async function recall(query, { topK = 5 } = {}) {
  const cfg = loadHindsightConfig();
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
