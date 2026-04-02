#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const reinforcement = require('./reinforcement');

const WORKSPACE = process.env.WORKSPACE || '/var/lib/openclaw/.openclaw/workspace';
const OUT_DIR = path.join(WORKSPACE, 'memory', 'reinforcement-capsules');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── helpers ──────────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'capsule';
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Format a heading-based capsule skeleton */
function buildNewCapsule(title, cluster) {
  const samples = cluster.samples || [];
  const facts = samples.map(x => `- ${x}`).join('\n');
  return `# ${title}

## 已确认事实
${facts}

## 变更记录

## 证据片段
`;
}

/** Check if section marker exists in content; return updated content */
function upsertSection(content, sectionMarker, entries, markerFormat) {
  const sectionRe = new RegExp(`^(${sectionMarker}.*)$`, 'm');
  if (sectionRe.test(content)) {
    // Append entries after the section heading
    return content.replace(sectionRe, (line) => {
      return line + '\n' + entries.join('\n');
    });
  } else {
    // Section missing — insert before "## 变更记录" or at end
    const changeLogRe = /^## 变更记录$/m;
    if (changeLogRe.test(content)) {
      return content.replace(changeLogRe, `${sectionMarker}\n${entries.join('\n')}\n\n$&`);
    }
    return content.trimEnd() + '\n\n' + sectionMarker + '\n' + entries.join('\n') + '\n';
  }
}

/** Parse existing capsule and return { confirmedFacts, changeLog, evidence } sections */
function parseCapsuleSections(content) {
  const sections = { confirmedFacts: [], changeLog: [], evidence: [] };
  let current = null;
  for (const line of content.split('\n')) {
    const lc = line.trim();
    if (/^## 已确认事实$/.test(lc)) { current = 'confirmedFacts'; continue; }
    if (/^## 变更记录$/.test(lc)) { current = 'changeLog'; continue; }
    if (/^## 证据片段$/.test(lc)) { current = 'evidence'; continue; }
    if (/^## /.test(lc)) { current = null; continue; }
    if (current && lc.startsWith('- ')) {
      sections[current].push(lc.slice(2));
    }
  }
  return sections;
}

/** Deduplicate bullet items */
function dedupBullets(existing, incoming) {
  const existSet = new Set(existing);
  return incoming.filter(x => !existSet.has(x));
}

// ─── core merge ───────────────────────────────────────────────────────────────

/**
 * Merge a cluster into a capsule file.
 *
 * @param {string} file     - absolute path to capsule file
 * @param {object} cluster  - { title, samples, action, clusterId, size }
 * @returns {{ mode: string, added: number }}
 */
function mergeCapsule(file, cluster) {
  const title = cluster.title || cluster.clusterId || 'untitled';
  const action = cluster.action || 'append';
  const samples = cluster.samples || [];

  // ── ignore ──────────────────────────────────────────────────────────────────
  if (action === 'ignore') {
    return { mode: 'ignore', added: 0 };
  }

  // ── create ─────────────────────────────────────────────────────────────────
  if (!fs.existsSync(file)) {
    const body = buildNewCapsule(title, cluster);
    fs.writeFileSync(file, body, 'utf8');
    return { mode: 'create', added: samples.length };
  }

  // ── read existing ───────────────────────────────────────────────────────────
  const prev = fs.readFileSync(file, 'utf8');
  const sections = parseCapsuleSections(prev);

  if (action === 'append') {
    // Add fresh samples to "已确认事实"
    const fresh = dedupBullets(sections.confirmedFacts, samples);
    if (!fresh.length) return { mode: 'noop', added: 0 };
    const entries = fresh.map(x => `- ${x}`);
    const next = upsertSection(prev, '## 已确认事实', entries);
    fs.writeFileSync(file, next, 'utf8');
    return { mode: 'append', added: fresh.length };

  } else if (action === 'supersede') {
    // Log the superseded event in "变更记录"
    const date = today();
    const oldSummary = sections.confirmedFacts.slice(0, 2).join('；') || '(旧内容)';
    const newSummary = samples.slice(0, 2).join('；');
    const logEntry = `- [${date}] supersede: ${oldSummary} → ${newSummary}`;
    const next = upsertSection(prev, '## 变更记录', [logEntry]);
    // Replace confirmed facts with new samples
    const factsHead = `# ${title}`;
    const changeHead = '## 变更记录';
    const changeIdx = next.indexOf(changeHead);
    const confirmedBlock = next.slice(0, changeIdx).replace(/^## 已确认事实\n/, '## 已确认事实\n');
    const newFacts = samples.map(x => `- ${x}`).join('\n') + '\n';
    const final = confirmedBlock + newFacts + next.slice(changeIdx);
    fs.writeFileSync(file, final, 'utf8');
    return { mode: 'supersede', added: samples.length };

  } else if (action === 'update') {
    // Log conflict in "变更记录", append new samples to "已确认事实"
    const date = today();
    const conflictNote = `update: 新内容与旧内容存在冲突——${samples.slice(0, 2).join('；')}`;
    const logEntry = `- [${date}] ${conflictNote}`;
    const next = upsertSection(prev, '## 变更记录', [logEntry]);
    const fresh = dedupBullets(sections.confirmedFacts, samples);
    if (fresh.length) {
      const entries = fresh.map(x => `- ${x}`);
      const next2 = upsertSection(next, '## 已确认事实', entries);
      fs.writeFileSync(file, next2, 'utf8');
    } else {
      fs.writeFileSync(file, next, 'utf8');
    }
    return { mode: 'update', added: fresh.length };

  } else {
    // fallback: append
    const fresh = dedupBullets(sections.confirmedFacts, samples);
    if (!fresh.length) return { mode: 'noop', added: 0 };
    const entries = fresh.map(x => `- ${x}`);
    const next = upsertSection(prev, '## 已确认事实', entries);
    fs.writeFileSync(file, next, 'utf8');
    return { mode: 'append', added: fresh.length };
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const sinceHours = Number(process.argv[2] || 72);
  const limit = Number(process.argv[3] || 120);

  // Load existing capsule files as content map
  const existingCapsules = {};
  try {
    const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.md'));
    for (const f of files) {
      existingCapsules[f] = fs.readFileSync(path.join(OUT_DIR, f), 'utf8');
    }
  } catch {}

  // Connect to memos PostgreSQL
  const { Pool } = require('pg');
  const pool = new Pool({
    host: process.env.MEMOS_PG_HOST || '127.0.0.1',
    port: Number(process.env.MEMOS_PG_PORT || 5432),
    database: process.env.MEMOS_PG_DB || 'memos',
    user: process.env.MEMOS_PG_USER || 'memos',
    password: process.env.MEMOS_PG_PASSWORD || 'memos_local_20260312',
  });

  function cleanMemoText(s) {
    const raw = String(s || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    const senderMatch = raw.match(/\[sender:\s*([^\]]+)\]/i);
    const sender = senderMatch ? String(senderMatch[1]).trim() : '';
    let cleaned = raw
      .replace(/\[uid:[^\]]*\]/gi, ' ')
      .replace(/\[source:[^\]]*\]/gi, ' ')
      .replace(/\[chat_id:[^\]]*\]/gi, ' ')
      .replace(/\[session:[^\]]*\]/gi, ' ')
      .replace(/\[timestamp:[^\]]*\]/gi, ' ')
      .replace(/\[sender:[^\]]*\]/gi, ' ')
      .replace(/\[message_id:[^\]]*\]/gi, ' ')
      .replace(/\[mode:[^\]]*\]/gi, ' ')
      .replace(/\[\[reply_to_current\]\]/gi, ' ')
      .replace(/^[>-]+\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return '';

    const lower = cleaned.toLowerCase();
    const hardNoisePatterns = [
      /^\{\"jsonrpc\"/i,
      /^layer2_answer:start/i,
      /^internal task completion event/i,
      /^stats: runtime/i,
      /^action:/i,
      /^system:/i,
      /^exec completed/i,
      /^model switched to/i,
      /^guard ✅/i,
      /^structure稿/i,
      /^mode: compact-fallback/i,
      /^#\s*🌅\s*茶老板晨报/i,
    ];
    if (hardNoisePatterns.some(re => re.test(cleaned))) return '';

    const softNoiseIncludes = [
      '茶老板晨报', 'guardian world', 'jsonrpc', 'internal task completion event',
      'stdout+stderr', 'cf-ray', 'request id:', 'model switched to', 'exec completed',
      'reply_to_current', '绩效评估', '████', 'sprint 交付', 'amazon味',
      'bias for action', 'dive deep',
    ];
    if (softNoiseIncludes.some(x => lower.includes(x))) return '';

    const valueSignals = [
      '茶老板', 'hindsight', 'hybrid-memory', 'memos', 'memorysearch', '耳洞枕', '穿孔枕',
      '答应', '承诺', '哪天', '什么时候', '记忆系统', '补强', '独立模块', 'github', 'cron',
      'backup', '灾备', 'session', 'pm2', 'gateway', 'fbm', '继续', '做啊', '看看', '统一好'
    ];
    const hasValueSignal = valueSignals.some(x => lower.includes(x.toLowerCase()));
    const shortImperative = /^(继续|做啊|你倒是做啊|帮我看看|统一好|收尾好了|改过来)$/.test(cleaned);

    const isK = /^k$/i.test(sender);
    const isUser = /茶老板|patrickk|bsbofmusic/i.test(sender);

    if (isK) {
      const keepK = [
        '根因', '结论', '修复', '已确认', '正式记忆主链', 'memorysearch', 'hybrid-memory',
        'hindsight', 'memos', 'session.maintenance', 'cron', '灾备', 'backup', 'systemd',
        'pm2', 'gateway', 'fbm', '配置键'
      ].some(x => lower.includes(String(x).toLowerCase()));
      if (!keepK) return '';
      const sentence = cleaned
        .split(/(?<=[。！？!?.])\s+/)
        .find(part => /根因|结论|修复|已确认|正式记忆主链|memorysearch|hybrid-memory|hindsight|session\.maintenance|cron|灾备|systemd|pm2|gateway|fbm|配置键/i.test(part));
      cleaned = (sentence || cleaned).trim();
      if (cleaned.length > 160) cleaned = cleaned.slice(0, 160);
    }

    if (isUser) {
      if (/^(好|好的|可以|好，可以|好，可以的|继续|继续查|查干净吧)$/.test(cleaned)) return '';
      if (cleaned.length > 180) cleaned = cleaned.slice(0, 180);
      return cleaned;
    }

    const longLikelyAssistantBlob = cleaned.length > 260 && !hasValueSignal;
    if (longLikelyAssistantBlob) return '';
    if (!hasValueSignal && !shortImperative && cleaned.length < 8) return '';
    if (cleaned.length > 180) cleaned = cleaned.slice(0, 180);
    return cleaned;
  }

  const sql = `
    SELECT content, updated_ts
    FROM memo
    WHERE updated_ts > floor(extract(epoch from now()) - $1 * 3600)::int
    ORDER BY updated_ts DESC
    LIMIT $2
  `;
  const { rows } = await pool.query(sql, [sinceHours, limit]);
  const texts = rows.map(r => cleanMemoText(r.content || '')).filter(Boolean);

  // Pass existing capsules so buildConsolidationPlan can compute actions
  const plan = reinforcement.buildConsolidationPlan(texts, existingCapsules);

  const written = [];
  const ops = [];
  for (const cluster of plan) {
    if (cluster.action === 'ignore') {
      ops.push({ clusterId: cluster.clusterId, title: cluster.title, action: 'ignore', mode: 'ignored', added: 0 });
      continue;
    }
    const file = path.join(OUT_DIR, cluster.filename || `${slugify(cluster.title || cluster.clusterId)}.md`);
    const result = mergeCapsule(file, cluster);
    written.push(file);
    ops.push({ file, title: cluster.title, ...result });
  }

  console.log(JSON.stringify({
    ok: true,
    sinceHours,
    scanned: texts.length,
    planCount: plan.length,
    writtenCount: written.length,
    written,
    ops,
    plan,
  }, null, 2));

  await pool.end();
}

main().catch(async err => {
  console.error(err.stack || err.message || String(err));
  try { await (require('pg').Pool && {}); } catch {}
  process.exit(1);
});
