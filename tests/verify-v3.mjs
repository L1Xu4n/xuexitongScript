import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(root, 'v3_optimized.js');
const userScriptPath = resolve(root, 'v3_optimized.user.js');
const userScript = readFileSync(userScriptPath, 'utf8');
const marker = '// ==/UserScript==\n\n';
const markerIndex = userScript.indexOf(marker);

if (markerIndex < 0) throw new Error('油猴元数据块缺失或格式错误');
const payload = userScript.slice(markerIndex + marker.length);
const source = readFileSync(sourcePath, 'utf8');
if (payload !== source) throw new Error('油猴脚本未由 v3_optimized.js 同步生成');

// 三处版本与面板显示必须相同，防止导入后仍显示旧版本或重复安装。
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const version = userScript.match(/^\/\/ @version\s+(\S+)$/m)?.[1];
if (version !== pkg.version || lock.version !== version || lock.packages[''].version !== version ||
    !source.includes(`<small>${version}</small>`)) throw new Error('版本号与面板显示未同步');

execFileSync(process.execPath, ['--check', sourcePath], { stdio: 'inherit' });
execFileSync(process.execPath, ['--check', userScriptPath], { stdio: 'inherit' });
execFileSync(process.execPath, ['--check', resolve(root, 'tests/browser-fixture.js')], { stdio: 'inherit' });
console.log(`V${version} source, userscript, package and lockfile are synchronized and syntactically valid.`);
