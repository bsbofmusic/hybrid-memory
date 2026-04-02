'use strict';

/**
 * llm.js — LLM client for hybrid-memory V2 reinforcement
 *
 * Provider priority:
 *   1. minimax provider from openclaw.json (models.providers.minimax)
 *      endpoint: https://api.minimaxi.com/anthropic/v1/messages (Anthropic-compatible)
 *      headers: x-api-key + anthropic-version
 *   2. env override: HYBRID_LLM_BASE_URL + HYBRID_LLM_API_KEY
 *   3. siliconflow fallback (memorySearch remote config, OpenAI-compat)
 *
 * Default model: MiniMax-M2.7
 * Fallback: rules-v1 (reinforcement.js) if LLM unavailable
 *
 * MiniMax activation note: capabilities are fully activated only when
 * system prompt clearly defines identity, rules, boundaries, and output format.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || '/var/lib/openclaw/.openclaw/openclaw.json';
const WORKSPACE = process.env.WORKSPACE || '/var/lib/openclaw/.openclaw/workspace';
const LLM_CACHE_DIR = path.join(WORKSPACE, '.layer2-runtime', 'llm-cache');
fs.mkdirSync(LLM_CACHE_DIR, { recursive: true });

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));

    // Priority 1: minimax provider (Anthropic-compatible endpoint)
    const mm = cfg?.models?.providers?.minimax;
    if (mm?.apiKey && mm?.baseUrl) {
      // minimax uses Anthropic-compat: https://api.minimaxi.com/anthropic/v1/messages
      // Normalize: strip trailing slash, ensure /anthropic/v1 suffix
      let base = mm.baseUrl.replace(/\/$/, '');
      if (!base.endsWith('/v1')) base = base.replace(/\/anthropic\/?$/, '') + '/anthropic/v1';
      return {
        apiKey: mm.apiKey,
        baseUrl: base,
        modelId: 'MiniMax-M2.7',
        provider: 'minimax-anthropic',
      };
    }

    // Priority 2: env override
    if (process.env.HYBRID_LLM_API_KEY) {
      return {
        apiKey: process.env.HYBRID_LLM_API_KEY,
        baseUrl: (process.env.HYBRID_LLM_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/$/, ''),
        modelId: process.env.HYBRID_LLM_MODEL_ID || 'Qwen/Qwen2.5-7B-Instruct',
        provider: 'env',
      };
    }

    // Priority 3: siliconflow fallback
    const ms = cfg?.agents?.defaults?.memorySearch || {};
    return {
      apiKey: ms?.remote?.apiKey || '',
      baseUrl: (ms?.remote?.baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/$/, ''),
      modelId: 'Qwen/Qwen2.5-7B-Instruct',
      provider: 'siliconflow',
    };
  } catch {
    return { apiKey: '', baseUrl: 'https://api.siliconflow.cn/v1', modelId: 'Qwen/Qwen2.5-7B-Instruct', provider: 'fallback' };
  }
}

// HYBRID_LLM_MODEL env can override the model id (e.g. MiniMax-M2.5)
const LLM_MODEL_OVERRIDE = process.env.HYBRID_LLM_MODEL || '';
const LLM_TIMEOUT_MS = parseInt(process.env.HYBRID_LLM_TIMEOUT_MS || '20000', 10);

// Expose for version reporting
const LLM_MODEL = LLM_MODEL_OVERRIDE || 'MiniMax-M2.7 (minimax provider)';

/**
 * Core chat completion call with disk cache.
 */
async function chat(systemPrompt, userContent, opts = {}) {
  const { maxTokens = 1024, temperature = 0, json = false, cacheKey } = opts;

  const cfg = loadConfig();
  const modelId = LLM_MODEL_OVERRIDE || cfg.modelId;

  // cache lookup
  const ck = cacheKey || crypto.createHash('sha1')
    .update(cfg.provider + modelId + systemPrompt + userContent).digest('hex');
  const cacheFile = path.join(LLM_CACHE_DIR, `${ck}.json`);
  try {
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached.ts && Date.now() - cached.ts < 3600_000) return cached.result;
    }
  } catch {}

  if (!cfg.apiKey) throw new Error(`LLM: no API key (provider: ${cfg.provider})`);

  let fetchPromise;
  if (cfg.provider === 'minimax-anthropic') {
    // Anthropic-compatible: x-api-key header, /messages endpoint
    // MiniMax does NOT support top-level `system` field (returns error 1033)
    // Inject system prompt as first user message instead
    const messages = systemPrompt
      ? [
          { role: 'user', content: `[系统指令]\n${systemPrompt}\n[用户输入]\n${userContent}` },
        ]
      : [{ role: 'user', content: userContent }];
    const body = {
      model: modelId,
      max_tokens: maxTokens,
      messages,
    };
    fetchPromise = fetch(`${cfg.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } else {
    // OpenAI-compatible fallback
    const body = {
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: maxTokens,
      temperature,
    };
    if (json) body.response_format = { type: 'json_object' };
    fetchPromise = fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  const res = await Promise.race([
    fetchPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), LLM_TIMEOUT_MS)),
  ]);

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`LLM ${res.status} (${cfg.provider}): ${txt.slice(0, 200)}`);
  }
  const data = await res.json();

  // parse response: anthropic-compat vs openai-compat
  let raw;
  if (cfg.provider === 'minimax-anthropic') {
    // content is an array; find the text block (type==='text'), not the thinking block
    const textBlock = (data?.content || []).find(b => b.type === 'text');
    raw = textBlock?.text || '';
    // strip any residual <thinking> tags just in case
    raw = raw.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
  } else {
    raw = (data?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  let result = raw;

  try { fs.writeFileSync(cacheFile, JSON.stringify({ result, ts: Date.now() })); } catch {}
  return result;
}

// ─── Task 1: Memo Value Classifier ───────────────────────────────────────────
const CLEANER_SYSTEM = `你是一个记忆价值分类器。
判断一条对话记录是否有长期记忆价值。

有价值（YES）= 包含以下任意一类：
- 事实/决策/配置/根因/项目节点
- 承诺/约定/规则/口径
- 系统架构/技术方案
- 用户明确的偏好/要求

无价值（NO）= 以下任意一类：
- 施工过程话（"继续"/"收到"/"好的"/"可以"）
- 系统日志/调试输出/JSON片段
- Agent自言自语/方法论旁白
- 重复确认语

只回答 YES 或 NO，不要解释。`;

async function classifyMemoValue(text) {
  const s = String(text || '').trim();
  if (!s || s.length < 6) return false;
  const { isNoiseText, isLowSignal } = require('./reinforcement');
  if (isLowSignal(s) || isNoiseText(s)) return false;
  try {
    const answer = await chat(CLEANER_SYSTEM, s.slice(0, 600), { maxTokens: 256, temperature: 0 });
    return /^yes/i.test(answer.trim());
  } catch {
    return s.length >= 20;
  }
}

async function batchClassifyMemos(texts) {
  const BATCH_SIZE = 20;
  const results = new Array(texts.length).fill(false);

  const BATCH_SYSTEM = `你是一个记忆价值分类器。
对以下编号的对话片段，逐条判断是否有长期记忆价值。
有价值=包含事实/决策/配置/根因/承诺/架构/用户要求。
无价值=施工过程话/系统日志/调试输出/重复确认语。
返回 JSON 数组，格式: [{"i":0,"v":true},{"i":1,"v":false},...]
只返回 JSON，不要解释。`;

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const numbered = batch.map((t, idx) => `[${start + idx}] ${String(t).slice(0, 300)}`).join('\n---\n');
    try {
      const raw = await chat(BATCH_SYSTEM, numbered, { maxTokens: 512, temperature: 0, json: true });
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item.i === 'number' && item.i < texts.length) results[item.i] = Boolean(item.v);
        }
      }
    } catch {
      const { isNoiseText, isLowSignal } = require('./reinforcement');
      for (let idx = start; idx < start + batch.length; idx++) {
        const s = String(texts[idx] || '').trim();
        results[idx] = s.length >= 20 && !isLowSignal(s) && !isNoiseText(s);
      }
    }
  }
  return results;
}

// ─── Task 2: Topic er ─────────────────────────────────────────────────
async function classifyTopics(texts, existingTopics = []) {
  if (!texts.length) return [];

  const topicList = existingTopics.length
    ? existingTopics.join('、')
    : '记忆系统架构、FBM补强层、Gateway运行链路、灾备定时链、耳洞枕项目、Reddit采集、OpenClaw配置、Discord集成、CDP浏览器、用户指令';

  const TOPIC_SYSTEM = `你是一个话题分类器，专门处理AI助手与用户的对话记录。
将每条文本归类到最合适的话题。
如果没有合适的现有话题，创建新话题（简短中文命名，不超过10字）。
现有话题：${topicList}

返回 JSON 数组，格式：
[{"i":0,"topic":"话题名","confidence":0.9},...]
只返回 JSON，不要解释。`;

  const numbered = texts.map((t, i) => `[${i}] ${String(t).slice(0, 200)}`).join('\n---\n');
  try {
    const raw = await chat(TOPIC_SYSTEM, numbered, { maxTokens: 1024, temperature: 0, json: true });
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(item => ({
        text: texts[item.i] || '',
        topic: String(item.topic || '未分类').trim(),
        confidence: Number(item.confidence || 0.5),
      }));
    }
  } catch {}

  // fallback: V1
  return texts.map(text => ({ text, topic: '未分类', confidence: 0.3 }));
}

// ─── Task 3: Action Decider ───────────────────────────────────────────────────
async function decideAction(newSamples, existingCapsuleContent) {
  if (!existingCapsuleContent) return 'create';
  if (!newSamples.length) return 'ignore';

  const DECIDE_SYSTEM = `你是一个记忆整理决策器。
给定一个已有的记忆胶囊（Markdown格式）和一批新的记忆片段，决定如何处理：
- append：新内容是对现有内容的补充，直接追加
- update：新内容修正或更新了现有内容的某些事实
- supersede：新内容完全替代了现有内容（旧内容已过时）
- ignore：新内容与现有内容高度重复，无需处理

只回答一个词：append / update / supersede / ignore，不要解释。`;

  const userContent = `已有胶囊：\n${existingCapsuleContent.slice(0, 800)}\n\n新片段：\n${newSamples.slice(0, 5).map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
  try {
    const answer = await chat(DECIDE_SYSTEM, userContent, { maxTokens: 256, temperature: 0 });
    const word = answer.trim().toLowerCase();
    if (['append', 'update', 'supersede', 'ignore'].includes(word)) return word;
  } catch {}

  // fallback: V1 char overlap
  const overlap = newSamples.filter(s => existingCapsuleContent.includes(s.slice(0, 20))).length;
  return overlap > newSamples.length * 0.7 ? 'ignore' : 'append';
}

// ─── Task 4: Query Expander ───────────────────────────────────────────────────
async function expandQueryLLM(query) {
  const EXPAND_SYSTEM = `你是一个搜索查询扩展器，专门处理记忆系统的查询。
给定一个查询，生成5-8个语义相关的扩展词/短语，用于提高召回率。
包括：同义词、别名、相关概念、英文对应词。
返回 JSON 数组，格式：["扩展词1","扩展词2",...]
只返回 JSON 数组，不要解释。`;

  const q = String(query || '').trim();
  if (!q) return { normalized: '', expansions: [], strategy: 'empty' };

  try {
    const raw = await chat(EXPAND_SYSTEM, q, { maxTokens: 512, temperature: 0.2 });
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const expansions = JSON.parse(match[0]).filter(x => typeof x === 'string' && x.trim());
      return { normalized: q, expansions: [q, ...expansions].slice(0, 12), strategy: 'llm-v2-minimax' };
    }
  } catch {}

  const { expandQuery } = require('./reinforcement');
  return expandQuery(query);
}

// ─── Task 5: Capsule Writer ───────────────────────────────────────────────────
async function writeCapsule(title, samples, existingContent = '') {
  const WRITE_SYSTEM = `你是一个记忆整理助手，负责把对话片段整理成结构化的记忆胶囊（Markdown格式）。

格式要求：
# {标题}

## 已确认事实
- 事实1
- 事实2

## 变更记录
- YYYY-MM-DD: 变更说明

## 证据片段
- 原始片段1（最多5条）

规则：
- 已确认事实：提炼客观事实，去掉施工过程话，保留决策/配置/根因/承诺
- 变更记录：今天日期 + 简短说明
- 语言：中文为主，技术术语保留英文
- 不要编造内容，只整理已有信息`;

  const today = new Date().toISOString().slice(0, 10);
  const samplesText = samples.slice(0, 10).map((s, i) => `${i + 1}. ${s}`).join('\n');
  const userContent = existingContent
    ? `标题：${title}\n今天日期：${today}\n\n已有胶囊：\n${existingContent.slice(0, 600)}\n\n新片段：\n${samplesText}`
    : `标题：${title}\n今天日期：${today}\n\n片段：\n${samplesText}`;

  try {
    const result = await chat(WRITE_SYSTEM, userContent, { maxTokens: 800, temperature: 0.1 });
    if (result.includes('##')) return result;
  } catch {}

  const facts = samples.slice(0, 5).map(s => `- ${s}`).join('\n');
  return `# ${title}\n\n## 已确认事实\n${facts}\n\n## 变更记录\n- ${today}: 自动整理\n\n## 证据片段\n${facts}\n`;
}

// ─── Task 6: Cross-topic Relation Finder ─────────────────────────────────────
async function findCrossTopicRelations(capsules) {
  if (capsules.length < 2) return [];

  const RELATE_SYSTEM = `你是一个知识图谱构建助手。
分析以下记忆胶囊，找出它们之间有意义的关联关系。
关系类型：causes（因果）、related（相关）、depends（依赖）、contradicts（矛盾）
只报告置信度高（>0.7）的关联。
返回 JSON 数组，格式：[{"from":"话题A","to":"话题B","relation":"causes","confidence":0.8,"note":"简短说明"}]
如果没有明显关联，返回空数组 []。`;

  const summaries = capsules.map(c => `[${c.title}]: ${c.summary || c.samples?.slice(0, 2).join(' / ') || ''}`).join('\n');
  try {
    const raw = await chat(RELATE_SYSTEM, summaries, { maxTokens: 512, temperature: 0, json: true });
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [];
}

module.exports = {
  chat,
  classifyMemoValue,
  batchClassifyMemos,
  classifyTopics,
  decideAction,
  expandQueryLLM,
  writeCapsule,
  findCrossTopicRelations,
  LLM_MODEL,
  loadConfig,
};
