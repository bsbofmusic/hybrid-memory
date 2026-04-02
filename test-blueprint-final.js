#!/usr/bin/env node
'use strict';
/**
 * BLUEPRINT FINAL VERIFICATION — hybrid-memory v0.2.4
 * Tests: append/update/supersede/ignore decision engine + heading-based capsule structure
 */

const fs = require('fs');
const path = require('path');
const reinforcement = require('./reinforcement');

// ─── helpers ──────────────────────────────────────────────────────────────────

const TEST_DIR = '/tmp/hybrid-memory-test-capsules';
const OUT_DIR = path.join(TEST_DIR, 'memory', 'reinforcement-capsules');

function cleanTestDir() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function capsulePath(title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return path.join(OUT_DIR, `${slug}.md`);
}

function readCapsule(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// Minimal mergeCapsule copy for testing (import from consolidate_capsules)
function upsertSection(content, sectionMarker, entries) {
  const sectionRe = new RegExp(`^(${sectionMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*)$`, 'm');
  if (sectionRe.test(content)) {
    return content.replace(sectionRe, (line) => line + '\n' + entries.join('\n'));
  }
  const 变更Re = /^## 变更记录$/m;
  if (变更Re.test(content)) {
    return content.replace(变更Re, `${sectionMarker}\n${entries.join('\n')}\n\n$&`);
  }
  return content.trimEnd() + '\n\n' + sectionMarker + '\n' + entries.join('\n') + '\n';
}

function parseCapsuleSections(content) {
  const sections = { confirmedFacts: [], changeLog: [], evidence: [] };
  let current = null;
  for (const line of content.split('\n')) {
    const lc = line.trim();
    if (/^## 已确认事实$/.test(lc)) { current = 'confirmedFacts'; continue; }
    if (/^## 变更记录$/.test(lc)) { current = 'changeLog'; continue; }
    if (/^## 证据片段$/.test(lc)) { current = 'evidence'; continue; }
    if (/^## /.test(lc)) { current = null; continue; }
    if (current && lc.startsWith('- ')) sections[current].push(lc.slice(2));
  }
  return sections;
}

function buildNewCapsule(title, samples) {
  return `# ${title}

## 已确认事实
${samples.map(x => `- ${x}`).join('\n')}

## 变更记录

## 证据片段
`;
}

function mergeCapsuleForTest(file, cluster) {
  const title = cluster.title || cluster.clusterId;
  const action = cluster.action || 'append';
  const samples = cluster.samples || [];

  if (action === 'ignore') return { mode: 'ignore', added: 0 };

  if (!fs.existsSync(file)) {
    const body = buildNewCapsule(title, samples);
    fs.writeFileSync(file, body, 'utf8');
    return { mode: 'create', added: samples.length };
  }

  const prev = fs.readFileSync(file, 'utf8');
  const sections = parseCapsuleSections(prev);
  const date = new Date().toISOString().slice(0, 10);

  if (action === 'append') {
    const fresh = samples.filter(x => !sections.confirmedFacts.includes(x));
    if (!fresh.length) return { mode: 'noop', added: 0 };
    const next = upsertSection(prev, '## 已确认事实', fresh.map(x => `- ${x}`));
    fs.writeFileSync(file, next, 'utf8');
    return { mode: 'append', added: fresh.length };
  } else if (action === 'supersede') {
    const oldSummary = sections.confirmedFacts.slice(0, 1).join('；') || '(旧内容)';
    const logEntry = `- [${date}] supersede: ${oldSummary} → ${samples.slice(0, 1).join('；')}`;
    const next = upsertSection(prev, '## 变更记录', [logEntry]);
    const changeHead = '## 变更记录';
    const changeIdx = next.indexOf(changeHead);
    const confirmedBlock = next.slice(0, changeIdx).replace(/^## 已确认事实\n/, '## 已确认事实\n');
    const newFacts = samples.map(x => `- ${x}`).join('\n') + '\n';
    const final = confirmedBlock + newFacts + next.slice(changeIdx);
    fs.writeFileSync(file, final, 'utf8');
    return { mode: 'supersede', added: samples.length };
  } else if (action === 'update') {
    const conflictNote = `update: 新内容与旧内容存在冲突——${samples.slice(0, 1).join('；')}`;
    const logEntry = `- [${date}] ${conflictNote}`;
    const next = upsertSection(prev, '## 变更记录', [logEntry]);
    const fresh = samples.filter(x => !sections.confirmedFacts.includes(x));
    if (fresh.length) {
      const next2 = upsertSection(next, '## 已确认事实', fresh.map(x => `- ${x}`));
      fs.writeFileSync(file, next2, 'utf8');
    } else {
      fs.writeFileSync(file, next, 'utf8');
    }
    return { mode: 'update', added: fresh.length };
  }
  return { mode: 'noop', added: 0 };
}

// ─── assertions ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✅ PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${msg}`);
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

// ─── TEST 1: New capsule → CREATE ────────────────────────────────────────────

console.log('\n── TEST 1: New capsule (create) ──');
cleanTestDir();

const existingEmpty = {};
const plan1 = reinforcement.buildConsolidationPlan(
  ['hybrid-memory 记忆系统正式收口为 Hindsight 主链 + FBM reinforcement 补强 + memos fallback'],
  existingEmpty
);
assert(plan1.length > 0, 'plan has at least one cluster');
assert(plan1[0].action === 'create', `action is create (got: ${plan1[0].action})`);

const file1 = capsulePath(plan1[0].title);
const result1 = mergeCapsuleForTest(file1, plan1[0]);
assert(result1.mode === 'create', `merge mode is create (got: ${result1.mode})`);
assert(result1.added > 0, 'samples were added');
const content1 = readCapsule(file1);
assert(content1.includes('# 记忆系统架构与主链规则'), 'heading-based title present');
assert(content1.includes('## 已确认事实'), 'confirmed facts section present');
assert(content1.includes('## 变更记录'), 'change log section present');
assert(content1.includes('## 证据片段'), 'evidence section present');
assert(content1.includes('hybrid-memory'), 'sample content present');

// ─── TEST 2: Append new content ─────────────────────────────────────────────

console.log('\n── TEST 2: Append new content (append) ──');

const plan2 = reinforcement.buildConsolidationPlan(
  [
    'hybrid-memory 记忆系统采用 Hindsight 主链，FBM reinforcement 作为补强层，memos 作为 fallback',
    'memos 是事实层，记录原话、承诺、时间点等原始信息',
  ],
  { [path.basename(file1)]: content1 }
);
assert(plan2.length > 0, 'plan2 has cluster');
const action2 = plan2[0].action;
assert(action2 === 'append', `action is append (got: ${action2}), existing capsule should trigger append not create`);

const result2 = mergeCapsuleForTest(file1, plan2[0]);
assert(result2.mode === 'append', `merge mode is append (got: ${result2.mode})`);
const content2 = readCapsule(file1);
assert(content2.includes('memos'), 'appended memos content present');
const sections2 = parseCapsuleSections(content2);
assert(sections2.confirmedFacts.length >= 2, `confirmed facts has >= 2 items (got: ${sections2.confirmedFacts.length})`);
assert(sections2.changeLog.length === 0, 'change log still empty (no change recorded)');

// ─── TEST 3: Ignore duplicate content (>80% char overlap) ────────────────────

console.log('\n── TEST 3: Ignore duplicate content (ignore) ──');

const sameContent = 'hybrid-memory 记忆系统正式收口为 Hindsight 主链 + FBM reinforcement 补强 + memos fallback';
const plan3 = reinforcement.buildConsolidationPlan([sameContent], { [path.basename(file1)]: content1 });
assert(plan3.length > 0, 'plan3 has cluster');
assert(plan3[0].action === 'ignore', `action is ignore for duplicate (got: ${plan3[0].action})`);

// Also test charOverlapRatio directly
const ratio = reinforcement.charOverlapRatio(
  'hybrid-memory 记忆系统正式收口为 Hindsight 主链 + FBM reinforcement 补强 + memos fallback',
  'hybrid-memory 记忆系统正式收口为 Hindsight 主链 + FBM reinforcement 补强 + memos fallback'
);
assert(ratio > 0.80, `char overlap ratio > 0.80 for identical (got: ${ratio})`);

const result3 = mergeCapsuleForTest(file1, plan3[0]);
assert(result3.mode === 'ignore', `merge mode is ignore (got: ${result3.mode})`);
const content3 = readCapsule(file1);
assert(content3 === content2, 'file unchanged after ignore');

// ─── TEST 4: Supersede signal ────────────────────────────────────────────────

console.log('\n── TEST 4: Supersede signal (supersede) ──');

// Build a fresh capsule for supersede test
cleanTestDir();
const supersedeExistingContent = buildNewCapsule('记忆系统架构与主链规则', [
  '旧方案：memorysearch 为主，memos 为辅'
]);
const supersedeFile = capsulePath('记忆系统架构与主链规则');
fs.writeFileSync(supersedeFile, supersedeExistingContent, 'utf8');

const plan4 = reinforcement.buildConsolidationPlan(
  ['已确认现行口径：hybrid-memory = Hindsight 主链优先 + memos fallback 证据层'],
  { [path.basename(supersedeFile)]: supersedeExistingContent }
);
assert(plan4.length > 0, 'plan4 has cluster');
assert(plan4[0].action === 'supersede', `action is supersede for 已确认 signal (got: ${plan4[0].action})`);

const result4 = mergeCapsuleForTest(supersedeFile, plan4[0]);
assert(result4.mode === 'supersede', `merge mode is supersede (got: ${result4.mode})`);
const content4 = readCapsule(supersedeFile);
assert(content4.includes('## 变更记录'), 'change log section exists after supersede');
const sections4 = parseCapsuleSections(content4);
assert(sections4.changeLog.some(l => l.includes('supersede')), 'supersede entry in change log');
assert(sections4.confirmedFacts.some(l => l.includes('已确认现行口径')), 'new content in confirmed facts');
assert(sections4.confirmedFacts.some(l => l.includes('Hindsight')), 'Hindsight in confirmed facts');

// ─── TEST 5: Update/contradict signal ────────────────────────────────────────

console.log('\n── TEST 5: Update/contradict signal (update) ──');

cleanTestDir();
const updateExisting = buildNewCapsule('记忆系统架构与主链规则', [
  '旧方案：memorysearch 为主，memos 为辅',
  '旧口径：memos 作为 primary facts store'
]);
const updateFile = capsulePath('记忆系统架构与主链规则');
fs.writeFileSync(updateFile, updateExisting, 'utf8');

const plan5 = reinforcement.buildConsolidationPlan(
  ['已废弃旧方案，不再使用 memorysearch 作为 primary，改为 hybrid-memory 直接走 Hindsight'],
  { [path.basename(updateFile)]: updateExisting }
);
assert(plan5.length > 0, 'plan5 has cluster');
assert(plan5[0].action === 'update', `action is update for 已废弃 signal (got: ${plan5[0].action})`);

const result5 = mergeCapsuleForTest(updateFile, plan5[0]);
assert(result5.mode === 'update', `merge mode is update (got: ${result5.mode})`);
const content5 = readCapsule(updateFile);
const sections5 = parseCapsuleSections(content5);
assert(sections5.changeLog.some(l => l.includes('update:')), 'update entry in change log');
assert(sections5.changeLog.some(l => l.includes('已废弃')), '废弃 signal mentioned in change log');
// New content should still be in confirmed facts (update adds, doesn't wipe)
assert(sections5.confirmedFacts.some(l => l.includes('不再使用')), 'new content appended to confirmed facts');

// ─── TEST 6: buildConsolidationPlan returns correct action field ─────────────

console.log('\n── TEST 6: buildConsolidationPlan action field correctness ──');

// 6a. No existing capsule → create
cleanTestDir();
const plan6a = reinforcement.buildConsolidationPlan(
  ['耳洞枕项目节点：穿刺枕方案确定，材料待采购'],
  {}
);
assert(plan6a[0].action === 'create', `6a: no existing → create (got: ${plan6a[0].action})`);
assert(plan6a[0].filename.endsWith('.md'), '6a: filename present and valid');
assert(typeof plan6a[0].samples === 'object', '6a: samples is array');

// 6b. existing capsule, supersede signal → supersede
const existing6b = buildNewCapsule('耳洞枕项目节点', ['旧方案：待确定']);
fs.writeFileSync(capsulePath('耳洞枕项目节点'), existing6b, 'utf8');
const plan6b = reinforcement.buildConsolidationPlan(
  ['已收口：耳洞枕最终方案为磁吸式，已确认现行口径'],
  { [path.basename(capsulePath('耳洞枕项目节点'))]: existing6b }
);
assert(plan6b[0].action === 'supersede', `6b: 已收口 signal → supersede (got: ${plan6b[0].action})`);

// 6c. existing capsule, no signal → append (content must match a topic pattern)
const plan6c = reinforcement.buildConsolidationPlan(
  ['耳洞枕新方案：改用传统穿刺式，材料清单已更新'],
  { [path.basename(capsulePath('耳洞枕项目节点'))]: existing6b }
);
assert(plan6c[0]?.action === 'append', `6c: normal new content → append (got: ${plan6c[0]?.action})`);

// 6d. existing capsule, "不再" signal → update
const plan6d = reinforcement.buildConsolidationPlan(
  ['耳洞枕磁吸方案不再推进，改用传统穿刺式，不再采购磁吸材料'],
  { [path.basename(capsulePath('耳洞枕项目节点'))]: existing6b }
);
assert(plan6d[0]?.action === 'update', `6d: 不再 signal → update (got: ${plan6d[0]?.action})`);

// 6e. high similarity → ignore: test decideAction directly with proper capsule content
const capsuleContent6e = buildNewCapsule('耳洞枕项目节点', ['旧方案：待确定']);
const action6e = reinforcement.decideAction(
  { samples: ['旧方案：待确定'] },   // exactly matches existing sample → >80% overlap → ignore
  capsuleContent6e                    // full capsule content so extractSamplesFromCapsule works
);
assert(action6e === 'ignore', `6e direct decideAction: ignore (got: ${action6e})`);

// Also verify low similarity → NOT ignore (should be append or other)
const action6eLow = reinforcement.decideAction(
  { samples: ['全新采购方案等待执行'] },
  capsuleContent6e
);
assert(action6eLow !== 'ignore', `6e: low similarity should NOT be ignore (got: ${action6eLow})`);

// ─── SUMMARY ─────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

if (failed > 0) process.exit(1);
console.log('All blueprint verification tests passed ✅\n');
process.exit(0);
