#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'consolidate_capsules.js'), 'utf8');
const sandbox = { module: {}, console, require, process, __dirname, __filename };
vm.runInNewContext(src + '\nmodule.exports = { cleanMemoText };', sandbox, { filename: 'consolidate_capsules.js' });
const { cleanMemoText } = sandbox.module.exports;

function assert(cond, msg) {
  if (!cond) {
    console.error('ASSERT_FAIL:', msg);
    process.exit(1);
  }
}

assert(cleanMemoText('[mode: compact-fallback] # 🌅 茶老板晨报 2026年4月2日') === '', 'morning news should be filtered');
assert(cleanMemoText('System: Exec completed (clear-gu, code 1)') === '', 'system exec noise should be filtered');
assert(cleanMemoText('[uid: a] [sender: 茶老板] 你倒是做啊') === '你倒是做啊', 'user message should survive');
assert(cleanMemoText('不，仿fbm补强你确实要做成独立模块逻辑，因为hindsight是开源软件，是需要跟随github升级的。') !== '', 'valuable architecture text should survive');
console.log(JSON.stringify({ ok: true }, null, 2));
