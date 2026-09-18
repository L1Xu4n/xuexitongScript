import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'v3_optimized.js'), 'utf8').replace(/^\uFEFF/, '');
const metadata = `// ==UserScript==
// @name         学习通学习助手 V3.4 本地修复版
// @namespace    local.codex.xuexitong
// @version      3.4.4
// @description  优化同节多视频接续、二倍速/静音、文档翻阅与完成检查，支持收起面板
// @author       chaolucky18 and contributors; L1Xu4n (fork)
// @homepageURL  https://github.com/L1Xu4n/xuexitongScript
// @supportURL   https://github.com/L1Xu4n/xuexitongScript/issues
// @match        *://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc2-ans/mycourse/studentstudy*
// @run-at       document-start
// @sandbox      DOM
// @grant        GM_info
// @noframes
// ==/UserScript==

`;

writeFileSync(resolve(root, 'v3_optimized.user.js'), `${metadata}${source}`, 'utf8');
