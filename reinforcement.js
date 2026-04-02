'use strict';

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function isLowSignal(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return true;
  if (s.length < 6) return true;
  return /^(好|好的|可以|行|继续|收到|嗯|哦|ok|yes|no)[。！!？? ]*$/i.test(s);
}

function isNoiseText(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return true;
  return /\[\[reply_to_current\]\]|^> \[|jsonrpc|layer2_answer:start|STDOUT\+STDERR|Internal task completion event|source: subagent|Stats: runtime|Action:|PUA v2|Sprint|KPI|Bias for Action|Dive Deep|Customer Obsession|Working Backwards|这里不是|茶老板，我直接|我现在做的这个|这轮实际落地|先给结论|先收口成一句话/i.test(s);
}

function cleanCandidateText(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\[\[reply_to_current\]\]\s*/i, '');
  s = s.replace(/^>\s*\[[^\]]+\]\s*/i, '');
  s = s.replace(/#\s*先给结论.*$/i, '').trim();
  s = s.replace(/#\s*先收口成一句话.*$/i, '').trim();
  s = s.replace(/#\s*这轮实际落地.*$/i, '').trim();
  return s;
}

function normalizeQuery(query) {
  const raw = String(query || '').trim();
  const lower = raw.toLowerCase();
  const cleaned = lower.replace(/[\s\u3000]+/g, ' ').trim();
  return { raw, lower, cleaned };
}

function expandQuery(query) {
  const { raw, lower, cleaned } = normalizeQuery(query);
  if (!raw) return { normalized: '', expansions: [], strategy: 'empty' };

  const expansions = [];
  const push = (...items) => items.forEach(x => x && expansions.push(String(x).trim()));

  push(raw, cleaned);

  const synonymGroups = [
    [/模糊搜索|模糊召回|模糊检索/g, ['fuzzy recall', 'query expansion', '模糊匹配']],
    [/原话|原文|具体怎么说/g, ['quote', 'verbatim', '原句']],
    [/承诺|答应过/g, ['promise', 'commitment', '约定']],
    [/时间点|什么时候|哪天/g, ['timestamp', 'date', 'when']],
    [/耳洞枕|穿孔枕/g, ['piercing pillow', 'ear piercing pillow']],
    [/hindsight/g, ['reflect', 'recall', 'memory reasoning']],
    [/memos/g, ['facts store', 'raw facts', 'memo']],
    [/记忆系统|memory system/g, ['memory architecture', 'memory stack']],
    [/补强|增强|reinforcement/g, ['reinforcement module', 'augmentation']],
  ];

  for (const [pattern, aliases] of synonymGroups) {
    if (pattern.test(lower)) push(...aliases);
  }

  const quoted = raw.match(/["“”'']([^"“”'']+)["“”'']/g) || [];
  for (const q of quoted) push(q.replace(/^["“”'']|["“”'']$/g, ''));

  const tokens = uniq(cleaned.split(/[^\p{L}\p{N}_-]+/u).filter(x => x && x.length >= 2));
  push(...tokens);

  return {
    normalized: cleaned,
    expansions: uniq(expansions).slice(0, 18),
    strategy: 'rules-v1',
  };
}

function textOf(item) {
  return String(
    item?.text || item?.content || item?.snippet || item?.summary || ''
  ).replace(/\s+/g, ' ').trim();
}

function dedupAndRerank({ query, expansions = [], memoResults = [], fileBrainHits = [], hindsightResults = [] }) {
  const all = [];
  for (const item of memoResults) all.push({ source: 'memos', raw: item, text: cleanCandidateText(textOf(item)), baseScore: Number(item?.score || 0) });
  for (const item of fileBrainHits) all.push({ source: 'file', raw: item, text: cleanCandidateText(textOf(item)), baseScore: Number(item?.score || 0) });
  for (const item of hindsightResults) all.push({ source: 'hindsight', raw: item, text: cleanCandidateText(textOf(item)), baseScore: Number(item?.score || 0.55) });

  const lowerQuery = String(query || '').toLowerCase();
  const quoteIntent = /原话|原文|怎么说|verbatim|quote/.test(lowerQuery);
  const timeIntent = /哪天|什么时候|时间点|date|when|timestamp/.test(lowerQuery);
  const causeIntent = /为什么|原因|根因|归因|怎么修/.test(lowerQuery);
  const archIntent = /架构|主链|分工|memory|记忆系统/.test(lowerQuery);

  const seen = new Map();
  const queryTerms = uniq([...(expansions || []), query].flatMap(x => String(x || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)));

  for (const item of all) {
    if (!item.text || isNoiseText(item.text) || isLowSignal(item.text)) continue;
    const key = item.text.toLowerCase().slice(0, 220);
    const hits = queryTerms.filter(t => t && item.text.toLowerCase().includes(t)).length;

    let sourceBoost = item.source === 'hindsight' ? 0.18 : item.source === 'file' ? 0.14 : 0.10;
    if (quoteIntent || timeIntent || causeIntent) {
      sourceBoost = item.source === 'memos' ? 0.22 : item.source === 'file' ? 0.12 : 0.08;
    }
    if (archIntent) {
      sourceBoost = item.source === 'file' ? 0.24 : item.source === 'hindsight' ? 0.12 : 0.04;
    }

    let penalty = 0;
    if (item.text.length > 220) penalty += 0.18;
    if (/茶老板，我|我直接|这轮|Sprint|KPI|Bias for Action|Dive Deep/i.test(item.text)) penalty += 0.35;
    if (item.source === 'memos' && item.text.length > 120 && !quoteIntent && !timeIntent && !causeIntent) penalty += 0.15;

    const score = item.baseScore + sourceBoost + Math.min(hits * 0.03, 0.24) - penalty;
    const existing = seen.get(key);
    if (!existing || score > existing.score) {
      seen.set(key, {
        source: item.source,
        text: item.text,
        score,
        hits,
        raw: item.raw,
      });
    }
  }

  const ranked = Array.from(seen.values())
    .filter(x => x.score >= 0.45)
    .sort((a, b) => (b.score - a.score) || (b.hits - a.hits) || (a.text.length - b.text.length))
    .slice(0, 8);

  return ranked;
}

// Compute character-overlap ratio between two strings (0–1)
function charOverlapRatio(a, b) {
  const sa = new Set(a.split(''));
  const sb = new Set(b.split(''));
  const intersection = [...sa].filter(c => sb.has(c)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

// Extract plain text samples from an existing capsule file content
function extractSamplesFromCapsule(content) {
  const samples = [];
  // Match bullet lines in any section (not headings)
  const matches = content.matchAll(/^\-\s+(.+)$/gm);
  for (const m of matches) {
    const t = m[1].trim();
    if (t && !t.startsWith('#') && t.length > 4) samples.push(t);
  }
  return samples;
}

// Decide the action for a cluster given existing capsule content
// Returns: 'create' | 'append' | 'update' | 'supersede' | 'ignore'
function decideAction(cluster, existingContent) {
  const samples = cluster.samples || [];
  if (!samples.length) return 'ignore';

  const existingSamples = existingContent ? extractSamplesFromCapsule(existingContent) : [];
  const newText = samples.join(' ');

  // Rule: high similarity (>80% char overlap) → ignore
  if (existingSamples.length > 0) {
    for (const ex of existingSamples) {
      if (charOverlapRatio(newText, ex) > 0.80) return 'ignore';
    }
  }

  // Rule: supersede signal
  const supersedeSignals = /已修复|已确认|现行口径|正式收口|已收口|已拍板/i;
  if (supersedeSignals.test(newText)) return 'supersede';

  // Rule: update/contradict signal
  const updateSignals = /不再|已废弃|已下线|已替换|已迁移/i;
  if (updateSignals.test(newText)) return 'update';

  // Default: append
  return 'append';
}

function buildConsolidationPlan(items = [], existingCapsules = {}) {
  // existingCapsules: { [filename: string]: string (file content) }
  const normalized = (items || []).map(x => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const clusters = [];

  const topicRules = [
    { key: 'memory-architecture', title: '记忆系统架构与主链规则', patterns: [/memorysearch|hybrid-memory|hindsight|memos|记忆系统|主链|memory architecture|layer2|文件脑|回忆路由|recall路由/i] },
    { key: 'reinforcement-fbm', title: 'FBM 补强层与独立模块设计', patterns: [/fbm|补强模块|reinforcement|独立模块|github升级|跟随github|仿生|自我整理|自演化|capsule|consolidat/i] },
    { key: 'gateway-runtime', title: 'Gateway / systemd / PM2 运行链路', patterns: [/gateway|systemd|pm2|openclaw\.service|启动链|18789|openclaw-gateway|进程管理/i] },
    { key: 'backup-disaster-recovery', title: '记忆系统灾备与定时链', patterns: [/cron|backup|灾备|session\.maintenance|snapshot|pg_dump|crontab|定时|备份|恢复链/i] },
    { key: 'piercing-pillow', title: '耳洞枕项目节点', patterns: [/耳洞枕|穿孔枕|piercing pillow|耳洞|样品|发货|大货/i] },
    { key: 'user-commitments', title: '用户指令与关键推进要求', patterns: [/做出来|落地测试|循环迭代优化|你倒是做啊|帮我全量检查|统一好|搞掂|验收|交付/i] },
    { key: 'reddit-crawler', title: 'Reddit 采集与爬虫工程', patterns: [/reddit|crawler|爬虫|采集|corner.bed|piercing.pillow.reddit|crawl_project/i] },
    { key: 'openclaw-config', title: 'OpenClaw 配置与插件', patterns: [/openclaw\.json|lossless-claw|plugins\.entries|plugins\.slots|contextEngine|session\.maintenance|memorySearch|agents\.defaults/i] },
    { key: 'discord-integration', title: 'Discord 集成与 Channel 配置', patterns: [/discord|channel.*id|bot.token|guild|webhook|discord.*integration/i] },
    { key: 'cdp-browser', title: 'CDP 浏览器自动化', patterns: [/cdp|puppeteer|chromium|browser.*automation|cdper|cdp-chatgpt|cdp-doubao/i] },
  ];

  function pickTopic(text) {
    for (const rule of topicRules) {
      if (rule.patterns.some(re => re.test(text))) return rule;
    }
    return null;
  }

  function extractKeywords(lower) {
    const ascii = lower.split(/[^\p{L}\p{N}_-]+/u).filter(x => x.length >= 3).slice(0, 4);
    const hanRuns = lower.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    const hans = [];
    for (const run of hanRuns) {
      hans.push(run);
      if (run.length >= 4) {
        for (let i = 0; i <= run.length - 2; i++) hans.push(run.slice(i, i + 2));
      }
    }
    return uniq([...ascii, ...hans]).slice(0, 8);
  }

  for (const text of normalized) {
    const lower = text.toLowerCase();
    const topic = pickTopic(text);
    if (!topic) continue;
    const keywords = extractKeywords(lower);
    let matched = clusters.find(c => c.topicKey === topic.key);
    if (!matched) {
      matched = { topicKey: topic.key, title: topic.title, keywords, items: [] };
      clusters.push(matched);
    } else {
      matched.keywords = uniq([...matched.keywords, ...keywords]).slice(0, 8);
    }
    matched.items.push(text);
  }

  return clusters.map((c, idx) => {
    const slug = String(c.title || c.keywords?.[0] || `cluster-${idx + 1}`).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `cluster-${idx + 1}`;
    const filename = `${slug}.md`;
    const hasExisting = Object.prototype.hasOwnProperty.call(existingCapsules, filename);
    const existingContent = hasExisting ? existingCapsules[filename] : undefined;
    const action = !hasExisting
      ? 'create'
      : decideAction({ samples: c.items.slice(0, 3) }, existingContent);

    return {
      clusterId: `cluster-${idx + 1}`,
      title: c.title,
      keywords: c.keywords,
      size: c.items.length,
      action,
      samples: c.items.slice(0, 3),
      filename,
    };
  });
}

module.exports = {
  normalizeQuery,
  expandQuery,
  dedupAndRerank,
  buildConsolidationPlan,
  charOverlapRatio,
  decideAction,
  extractSamplesFromCapsule,
};
