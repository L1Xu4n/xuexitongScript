const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { JSDOM } = require('jsdom');
const createPlayer = require('../v3_optimized.js');

const tree = '<div id="coursetree"><ul><li><div class="posCatalog_select posCatalog_active" id="unit1"><span class="posCatalog_name">单元一</span></div><div class="posCatalog_select" id="unit2"><span class="posCatalog_name">单元二</span></div></li></ul></div>';

// 清空 Promise 回调队列，不依赖真实时间或真实学校服务。
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

// 创建本地合成 DOM、可控时钟和计时器登记表，每项测试结束后清理。
function harness(t, html = tree, configs = {}) {
    const dom = new JSDOM(html, { url: 'https://mooc1.chaoxing.com/mycourse/studentstudy', runScripts: 'outside-only' });
    const win = dom.window;
    const intervals = new Map();
    let clock = 100000;
    let timerId = 0;
    // 模拟轮询注册；测试通过 advance 主动推进，而不让后台计时器运行。
    win.setInterval = callback => { intervals.set(++timerId, callback); return timerId; };
    // 模拟取消轮询，以便断言重复运行没有泄漏。
    win.clearInterval = id => intervals.delete(id);
    win.console.info = () => {};
    const app = createPlayer(win, {
        now: () => clock,
        configs: { settleMs: 1000, documentDwellMs: 1000, resourceTimeoutMs: 5000, ...configs },
    });
    // 完成一个测试后释放窗口与所有助手实例。
    t.after(() => { app.destroy(); win.__xuexitongPlayerV3?.destroy(); win.close(); });
    return {
        win, doc: win.document, app, intervals,
        // 在真实 DOM 已布置后开始脚本，并等待异步 play 回调。
        async start() { app.run(); await flush(); },
        // 只推进模拟时钟，每次精确执行一次状态检查。
        async advance(ms = 1000) { clock += ms; app.tick(); await flush(); },
    };
}

// 插入同源测试框架，可用 className 模拟超星的视频或文档外壳。
function frame(document, className = '') {
    const el = document.createElement('iframe');
    el.className = className;
    document.body.appendChild(el);
    Object.defineProperty(el.contentDocument, 'readyState', { configurable: true, value: 'complete' });
    return el;
}

// 模拟真实跨域 iframe：contentDocument 为 null，访问子 window.document 抛错。
function denyFrame(element) {
    Object.defineProperty(element, 'contentDocument', { value: null });
    Object.defineProperty(element, 'contentWindow', {
        value: { get document() { throw new Error('cross-origin'); } },
    });
}

// 模拟 HTMLMediaElement 的原生状态；没有任何学习上报请求。
function media(document, source = 'synthetic-video-1') {
    const el = document.createElement('video');
    document.body.appendChild(el);
    const state = { paused: true, ended: false, currentTime: 0, currentSrc: source, seeking: false, error: null, calls: 0 };
    for (const key of ['paused', 'ended', 'currentTime', 'currentSrc', 'seeking', 'error']) {
        Object.defineProperty(el, key, { configurable: true, get: () => state[key] });
    }
    // 合成播放只修改测试状态并返回浏览器形状的 Promise。
    el.play = () => { state.calls++; state.paused = false; return Promise.resolve(); };
    // 合成暂停保留结束状态，便于检查停止逻辑。
    el.pause = () => { state.paused = true; };
    return {
        el, state,
        // 模拟自然结束事件，可连续触发以验证幂等性。
        end() { state.ended = true; state.paused = true; el.dispatchEvent(new document.defaultView.Event('ended')); },
    };
}

// 创建标准 PDF.js 形状的分页器，翻页回调可以由测试替换为故障版本。
function pagedDocument(document, total = 3) {
    const el = frame(document, 'ans-attach-online');
    const current = el.contentDocument;
    current.body.innerHTML = '<input id="pageNumber" value="1"><span id="numPages">/ ' + total + '</span><button id="next">下一页</button><div class="page">合成文档</div>';
    const input = current.getElementById('pageNumber');
    const next = current.getElementById('next');
    // 使用可观察的输入框页码变化模拟原生翻页。
    next.onclick = () => { input.value = String(Math.min(total, Number(input.value) + 1)); };
    return { el, current, input, next };
}

// 创建可测量的滚动文档，允许模拟懒加载增加高度。
function scrollDocument(document, height = 1600) {
    const el = frame(document, 'ans-attach-online');
    const current = el.contentDocument;
    current.body.innerHTML = '<p>这是一份足够长的本地合成文档，用于检查逐屏阅读。</p>';
    const area = current.documentElement;
    const layout = { height, viewport: 500 };
    Object.defineProperty(area, 'scrollHeight', { get: () => layout.height });
    Object.defineProperty(area, 'clientHeight', { get: () => layout.viewport });
    return { el, current, area, layout };
}

// 给合成资源添加平台任务点外壳；只在测试中模拟平台确认保存后的 DOM 更新。
function taskPoint(element, complete = false) {
    const wrapper = element.ownerDocument.createElement('div');
    wrapper.className = 'ans-attach-ct';
    const icon = element.ownerDocument.createElement('div');
    icon.className = 'ans-job-icon';
    element.before(wrapper);
    wrapper.append(icon, element);
    // 同步平台外壳类别与无障碍完成文字，避免测试把矛盾状态当成功。
    function setComplete(value) {
        wrapper.classList.toggle('ans-job-finished', value);
        icon.setAttribute('aria-label', value ? '任务点已完成' : '任务点未完成');
    }
    setComplete(complete);
    return { wrapper, icon, setComplete };
}

// 模拟目录对整个小节给出的明确完成标记，不用播放状态推算完成。
function completeUnit(document, id = 'unit1') {
    const marker = document.createElement('span');
    marker.className = 'icon_Completed prevTips';
    marker.innerHTML = '<span class="prevHoverTips">已完成</span>';
    document.getElementById(id).appendChild(marker);
    return marker;
}

// 创建带合成小节编号和卡片编号的课程框架，模拟平台真实的内容地址。
function coursePage(document, chapter, card = 0) {
    const iframe = frame(document);
    iframe.id = 'iframe';
    iframe.setAttribute('src', '/mooc-ans/knowledge/cards?knowledgeid=' + chapter + '&num=' + card);
    iframe.contentDocument.open();
    iframe.contentDocument.write('<!doctype html><html><body><p>合成课程正文</p></body></html>');
    iframe.contentDocument.close();
    Object.defineProperty(iframe.contentDocument, 'readyState', { configurable: true, value: 'complete' });
    return iframe;
}

// 第一视频结束只能前进到本小节第二视频，不能提前点击下一小节。
test('plays every video in one unit before navigating', async t => {
    const h = harness(t);
    const outer = frame(h.doc);
    const a = media(frame(outer.contentDocument, 'ans-insertvideo-online').contentDocument, 'a');
    const b = media(frame(outer.contentDocument, 'ans-insertvideo-online').contentDocument, 'b');
    let clicks = 0;
    h.doc.querySelector('#unit2 .posCatalog_name').onclick = () => clicks++;
    await h.start();
    assert.equal(a.state.calls, 1);
    assert.equal(b.state.calls, 0);
    a.end(); a.end();
    await h.advance();
    await h.advance();
    assert.equal(b.state.calls, 1);
    assert.equal(clicks, 0);
    b.end();
    await h.advance(); await h.advance(); await h.advance();
    assert.equal(clicks, 1);
    await h.advance();
    assert.equal(clicks, 1);
});

// 后面的播放器尚未出现 video 时必须保留其队列位置。
test('waits for a delayed second player instead of leaving the unit', async t => {
    const h = harness(t);
    const a = media(frame(h.doc, 'ans-insertvideo-online').contentDocument);
    const later = frame(h.doc, 'ans-insertvideo-online');
    await h.start(); a.end(); await h.advance(); await h.advance();
    assert.match(h.app._message, /等待/);
    assert.equal(h.app._transition, null);
    const b = media(later.contentDocument, 'b');
    await h.advance();
    assert.equal(b.state.calls, 1);
});

// 一个不可访问的无关 iframe 不能阻断后面的可访问播放器。
test('isolates an unrelated cross-origin iframe failure', async t => {
    const h = harness(t);
    const unrelated = frame(h.doc);
    denyFrame(unrelated);
    const a = media(frame(h.doc, 'ans-insertvideo-online').contentDocument);
    await h.start();
    assert.equal(a.state.calls, 1);
});

// 若跨域的是课程播放器，则停止而不是漏掉任务。
test('does not skip an inaccessible resource iframe', async t => {
    const h = harness(t);
    const blocked = frame(h.doc, 'ans-insertvideo-online');
    denyFrame(blocked);
    const a = media(h.doc);
    await h.start(); await h.advance(6000);
    assert.equal(a.state.calls, 0);
    assert.equal(h.app._running, false);
    assert.match(h.app._message, /跨域/);
});

// 同一个 DOM 播放器更换 src 必须视作另一项视频。
test('reused video element with changed source plays as a new resource', async t => {
    const h = harness(t);
    const a = media(h.doc, 'a');
    await h.start(); a.end(); await h.advance();
    a.state.currentSrc = 'b'; a.state.ended = false; a.state.currentTime = 0;
    await h.advance();
    assert.equal(a.state.calls, 2);
});

// 被隐藏的旧播放器不进入本页队列。
test('ignores videos in hidden frames', async t => {
    const h = harness(t);
    const old = frame(h.doc);
    const a = media(old.contentDocument);
    old.hidden = true;
    const b = media(h.doc, 'b');
    await h.start();
    assert.equal(a.state.calls, 0);
    assert.equal(b.state.calls, 1);
});

// 文档必须逐页停留；最后一页停留结束之后才播放后续视频。
test('reads all document pages before the next video', async t => {
    const h = harness(t);
    const pdf = pagedDocument(h.doc);
    const a = media(h.doc);
    await h.start();
    await h.advance();
    assert.equal(pdf.input.value, '2');
    await h.advance(); await h.advance();
    assert.equal(pdf.input.value, '3');
    assert.equal(a.state.calls, 0);
    await h.advance(); await h.advance(); await h.advance();
    assert.equal(a.state.calls, 1);
});

// 原生按钮没有改变页码时必须超时停下，不得声称阅读完成。
test('stops when a document next-page click has no effect', async t => {
    const h = harness(t);
    const pdf = pagedDocument(h.doc);
    pdf.next.onclick = () => {};
    await h.start(); await h.advance(); await h.advance(6000);
    assert.equal(h.app._running, false);
    assert.match(h.app._message, /页码/);
    assert.equal(h.app._completed.size, 0);
});

// 逐屏滚动必须观察位移，并在稳定底部停留后才完成。
test('scrolls a document to its stable end', async t => {
    const h = harness(t);
    const document = scrollDocument(h.doc);
    await h.start();
    await h.advance();
    assert.equal(document.area.scrollTop, 500);
    for (let i = 0; i < 9; i++) await h.advance();
    assert.equal(document.area.scrollTop, 1100);
    assert.equal(h.app._completed.has(document.el), true);
});

// 文档末尾懒加载新内容时需要继续阅读，不能使用旧高度直接结束。
test('lazy loading at the document bottom resets completion dwell', async t => {
    const h = harness(t);
    const document = scrollDocument(h.doc, 500);
    await h.start();
    document.layout.height = 1200;
    await h.advance();
    assert.equal(h.app._completed.size, 0);
    assert.equal(document.area.scrollTop, 500);
});

// 滚动属性不接受变更时保留未完成状态。
test('stops when document scrolling is ineffective', async t => {
    const h = harness(t);
    const document = scrollDocument(h.doc);
    Object.defineProperty(document.area, 'scrollTop', { get: () => 0, set() {} });
    await h.start(); await h.advance(); await h.advance(6000);
    assert.equal(h.app._running, false);
    assert.equal(h.app._completed.size, 0);
});

// 未知文档和内置 PDF 阅读器不得被自动标记为已浏览。
test('unknown document viewer stops without advancing', async t => {
    const h = harness(t);
    frame(h.doc, 'ans-attach-online');
    await h.start(); await h.advance(6000);
    assert.equal(h.app._running, false);
    assert.equal(h.app._completed.size, 0);
    assert.match(h.app._message, /未识别/);
});

// 浏览完成后平台任务点没有完成标记时，不应进入下一小节。
test('waits for a platform task marker and then stops if unconfirmed', async t => {
    const h = harness(t, tree + '<div class="ans-attach-ct"><span class="ans-job-icon"></span></div>');
    const a = media(h.doc);
    h.doc.querySelector('.ans-attach-ct').appendChild(a.el);
    await h.start(); a.end(); await h.advance(); await h.advance(); await h.advance(6000);
    assert.equal(h.app._running, false);
    assert.match(h.app._message, /任务点尚未/);
});

// 停止必须解除事件和计时器，旧结束事件不能恢复自动化。
test('stop cancels future work and restores media settings', async t => {
    const h = harness(t, tree, { playbackRate: 1.5 });
    const a = media(h.doc);
    a.el.muted = false; a.el.playbackRate = 1;
    await h.start();
    assert.equal(a.el.playbackRate, 1.5);
    h.app.stop(); a.end(); await h.advance(10000);
    assert.equal(h.intervals.size, 0);
    assert.equal(a.el.playbackRate, 1);
    assert.equal(a.state.paused, true);
    assert.equal(h.app._completed.size, 0);
});

// play Promise 在停止后才返回，也不能重新进入播放或导航状态。
test('late play resolution cannot resurrect a stopped run', async t => {
    const h = harness(t);
    const a = media(h.doc);
    let resolvePlay;
    a.el.play = () => new Promise(resolve => { resolvePlay = resolve; });
    await h.start();
    h.app.stop(); resolvePlay(); await flush();
    assert.equal(h.app._running, false);
    assert.equal(h.intervals.size, 0);
    assert.equal(a.state.paused, true);
});

// 未返回的 play Promise 也不能让检查循环永久挂起。
test('times out an unresolved play promise', async t => {
    const h = harness(t);
    const a = media(h.doc);
    a.el.play = () => new Promise(() => {});
    await h.start(); await h.advance(16000);
    assert.equal(h.app._running, false);
    assert.match(h.app._message, /启动超时/);
});

// 浏览器拒绝有声自动播放时，只尝试静音正常播放。
test('uses muted fallback for NotAllowedError', async t => {
    const h = harness(t);
    const a = media(h.doc);
    a.el.play = () => {
        a.state.calls++;
        if (!a.el.muted) return Promise.reject(new h.win.DOMException('gesture needed', 'NotAllowedError'));
        a.state.paused = false;
        return Promise.resolve();
    };
    await h.start(); await h.advance();
    assert.equal(a.el.muted, true);
    assert.equal(a.state.calls, 2);
    assert.equal(h.app.configs.muted, true);
    assert.equal(h.app._panel.shadowRoot.getElementById('muted').checked, true);
    assert.equal(h.app._running, true);
});

// 初始化中断可以重试，但次数有上限。
test('AbortError retries are bounded', async t => {
    const h = harness(t, tree, { maxRetries: 2 });
    const a = media(h.doc);
    a.el.play = () => { a.state.calls++; return Promise.reject(new h.win.DOMException('interrupted', 'AbortError')); };
    await h.start(); await h.advance(2000); await h.advance(2000);
    assert.equal(a.state.calls, 2);
    assert.equal(h.app._running, false);
});

// 用户或平台暂停后不强行恢复，保留验证与交互的处理机会。
test('respects playback pause and visible verification dialogs', async t => {
    const h = harness(t);
    const a = media(h.doc);
    await h.start(); a.state.paused = true; await h.advance();
    assert.equal(h.app._running, false);
    const dialog = h.doc.createElement('div');
    dialog.setAttribute('role', 'dialog'); dialog.textContent = '请完成验证码'; h.doc.body.appendChild(dialog);
    await h.start();
    assert.equal(h.app._running, false);
    assert.equal(a.state.calls, 1);
});

// 在测验步骤不点击下一步，不替用户提交答案。
test('chapter tests require manual action', async t => {
    const h = harness(t, tree + '<span class="prev_title">章节测验</span><button id="prevNextFocusNext">下一节</button>');
    let clicks = 0;
    h.doc.getElementById('prevNextFocusNext').onclick = () => clicks++;
    await h.start();
    assert.equal(h.app._running, false);
    assert.equal(clicks, 0);
});

// 单元切换的目录先变而旧播放器还在时，必须等内容实际替换。
test('navigation never takes ownership of a stale player', async t => {
    const h = harness(t);
    const a = media(h.doc);
    h.doc.querySelector('#unit2 .posCatalog_name').onclick = () => {
        h.doc.getElementById('unit1').classList.remove('posCatalog_active');
        h.doc.getElementById('unit2').classList.add('posCatalog_active');
    };
    await h.start(); a.end(); await h.advance(); await h.advance(); await h.advance();
    await h.advance(2000);
    assert.ok(h.app._transition);
    assert.equal(a.state.calls, 1);
    a.el.remove();
    const b = media(h.doc, 'b');
    await h.advance();
    assert.equal(h.app._transition, null);
    assert.equal(b.state.calls, 1);
});

// 无目录且无播放器时应显示等待并最终提示，而不是静默失败。
test('startup waits for delayed DOM and needs no page jQuery', async t => {
    const h = harness(t, '<main>loading</main>');
    await h.start();
    assert.ok(h.doc.getElementById('xuexitong-helper-panel'));
    assert.equal(h.win.jQuery, undefined);
    h.doc.body.insertAdjacentHTML('afterbegin', tree);
    const a = media(h.doc);
    await h.advance();
    assert.equal(a.state.calls, 1);
    assert.equal(h.doc.querySelector('script[src]'), null);
});

// 真实生成入口在没有 $, jQuery 和 GM 函数的隔离环境中可独立启动。
test('generated userscript boots and repeated injection disposes prior instance', async t => {
    const h = harness(t);
    const a = media(h.doc);
    const bundle = readFileSync(resolve(__dirname, '../v3_optimized.user.js'), 'utf8');
    h.win.eval(bundle); await flush();
    const previous = h.win.__xuexitongPlayerV3;
    h.win.eval(bundle); await flush();
    assert.equal(previous._running, false);
    assert.equal(h.doc.querySelectorAll('#xuexitong-helper-panel').length, 1);
    assert.equal(h.intervals.size, 1);
    assert.equal(a.state.calls, 2);
    assert.equal(h.win.$, undefined);
});

// 空白 iframe 可能是未初始化的播放器，必须等其内容而不是提前离开。
test('reserves a queue position for a blank delayed iframe', async t => {
    const h = harness(t);
    const a = media(h.doc);
    const delayed = frame(h.doc);
    await h.start(); a.end(); await h.advance(); await h.advance();
    assert.equal(h.app._transition, null);
    const b = media(delayed.contentDocument, 'later');
    await h.advance();
    assert.equal(b.state.calls, 1);
});

// 同名步骤也由原始编号和位置区分，不能沿用前一个步骤的完成缓存。
test('a new step reusing the same media source is not already completed', async t => {
    const h = harness(t, tree + '<span class="prev_title" title="视频">2视频</span><span class="prev_white" title="视频">3视频</span>');
    const a = media(h.doc);
    await h.start(); a.end(); await h.advance();
    const old = h.doc.querySelector('.prev_title');
    const next = h.doc.querySelector('.prev_white');
    old.className = 'prev_white'; next.className = 'prev_title';
    a.state.ended = false; a.state.currentTime = 0;
    await h.advance();
    assert.equal(a.state.calls, 1);
    assert.ok(h.app._transition);
    await h.advance(1500);
    assert.equal(a.state.calls, 2);
    assert.equal(h.app._completed.size, 0);
});

// 两个“视频”页签自动切换时仍须观察新内容，且不误跳到下一小节。
test('navigates between two video steps with the same normalized title', async t => {
    const h = harness(t, tree + '<span class="prev_title" title="视频">2视频</span><span class="prev_white" title="视频">3视频</span>');
    const a = media(h.doc);
    let b;
    const old = h.doc.querySelector('.prev_title');
    const next = h.doc.querySelector('.prev_white');
    next.onclick = () => {
        old.className = 'prev_white'; next.className = 'prev_title';
        a.el.remove(); b = media(h.doc, 'next-step');
    };
    await h.start(); a.end(); await h.advance(); await h.advance(); await h.advance(); await h.advance(2000);
    assert.equal(b.state.calls, 1);
    assert.equal(h.app._currentNode().id, 'unit1');
});

// 计数文本可以带中文或英文，但不能把其中的当前页误当总页数。
for (const label of ['第 1 页，共 3 页', '共 3 页', '/ 3', 'of 3', '3']) {
    test('reads total-page label: ' + label, async t => {
        const h = harness(t);
        const pdf = pagedDocument(h.doc);
        pdf.current.getElementById('numPages').textContent = label;
        await h.start(); await h.advance();
        assert.equal(pdf.input.value, '2');
        assert.equal(h.app._completed.size, 0);
    });
}

// 页码格式不可靠时不得回退成一个短页面并错误结束。
test('unrecognized pagination cannot fall back to false scroll completion', async t => {
    const h = harness(t);
    const pdf = pagedDocument(h.doc);
    pdf.current.getElementById('numPages').textContent = '未知';
    await h.start(); await h.advance(6000);
    assert.equal(h.app._running, false);
    assert.equal(h.app._completed.size, 0);
    assert.match(h.app._message, /页码格式/);
});

// 有侧边栏时只滚动已识别阅读器，侧栏长度不能决定阅读完成。
test('document reader wins over a larger unrelated scrollable sidebar', async t => {
    const h = harness(t);
    const pdf = frame(h.doc, 'ans-attach-online');
    const current = pdf.contentDocument;
    current.body.innerHTML = '<aside style="overflow-y:auto">侧栏</aside><div id="viewerContainer" style="overflow-y:auto"><div class="pdfViewer"><p>文档内容</p></div></div>';
    const sidebar = current.querySelector('aside');
    const reader = current.getElementById('viewerContainer');
    for (const element of [sidebar, reader]) {
        Object.defineProperty(element, 'clientHeight', { value: 400 });
        Object.defineProperty(element, 'scrollHeight', { value: element === sidebar ? 9000 : 1500 });
    }
    await h.start(); await h.advance();
    assert.equal(reader.scrollTop, 400);
    assert.equal(sidebar.scrollTop, 0);
});

// 新实例拥有同一个 video 时，已销毁实例的异步结果不能暂停它。
test('late playback from a disposed instance does not pause the new owner', async t => {
    const h = harness(t);
    const a = media(h.doc);
    let oldResolve;
    a.el.play = () => new Promise(resolve => { oldResolve = resolve; });
    await h.start(); h.app.destroy();
    a.el.play = () => { a.state.paused = false; return Promise.resolve(); };
    const replacement = createPlayer(h.win);
    t.after(() => replacement.destroy());
    replacement.run(); await flush(); oldResolve(); await flush();
    assert.equal(a.state.paused, false);
    assert.equal(replacement._running, true);
});

// 页面本来已自然结束的媒体不应调用 play 从头重播。
test('does not restart an already ended video', async t => {
    const h = harness(t);
    const a = media(h.doc); a.state.ended = true;
    await h.start(); await h.advance();
    assert.equal(a.state.calls, 0);
    assert.equal(h.app._completed.has(a.el), true);
});

// 没有可靠激活节点时不能猜测或点击任意下一节。
test('unknown active catalog node stops navigation', async t => {
    const h = harness(t);
    h.doc.getElementById('unit1').classList.remove('posCatalog_active');
    h.app.nextUnit();
    assert.equal(h.app._running, false);
    assert.match(h.app._message, /无法确定/);
});

// 油猴的匹配路径和单框架沙箱元数据始终随构建产物交付。
test('userscript metadata includes both study routes and a DOM-only sandbox', () => {
    const bundle = readFileSync(resolve(__dirname, '../v3_optimized.user.js'), 'utf8');
    assert.match(bundle, /@match\s+\*:\/\/\*\.chaoxing\.com\/mycourse\/studentstudy\*/);
    assert.match(bundle, /@match\s+\*:\/\/\*\.chaoxing\.com\/mooc2-ans\/mycourse\/studentstudy\*/);
    assert.match(bundle, /@sandbox\s+DOM/);
    assert.match(bundle, /@noframes/);
    assert.doesNotMatch(bundle, /code\.jquery\.com/);
});

// 复现真实页面的双重附件类别，未完成图标不能让尚未播放的视频走文档分支。
test('real dual-class video attachment starts playback before completion checks', async t => {
    const h = harness(t);
    const outer = frame(h.doc);
    outer.id = 'iframe';
    const card = outer.contentDocument.createElement('div');
    card.className = 'ans-attach-ct videoContainer';
    card.innerHTML = '<div class="ans-job-icon ans-job-video" aria-label="任务点未完成"></div>';
    outer.contentDocument.body.appendChild(card);
    const player = frame(outer.contentDocument, 'ans-attach-online ans-insertvideo-online');
    card.appendChild(player);
    const a = media(player.contentDocument);
    player.contentDocument.body.insertAdjacentHTML('beforeend', '<p>播放器说明和控制条，不能被当作一页已读完的文档。</p>');
    Object.defineProperty(player.contentDocument.documentElement, 'clientHeight', { value: 500 });
    Object.defineProperty(player.contentDocument.documentElement, 'scrollHeight', { value: 500 });
    await h.start();
    assert.equal(a.state.calls, 1);
    assert.equal(h.app._active.task.kind, 'video');
    for (let i = 0; i < 6; i++) { a.state.currentTime++; await h.advance(); }
    assert.equal(h.app._running, true);
    assert.equal(h.app._completed.size, 0);
    assert.doesNotMatch(h.app._message, /任务点尚未|资源已浏览/);
});

// 缺少专用 class 时，视频模块路径仍必须优先于通用附件类别。
test('video module URL wins over the generic attachment class', async t => {
    const h = harness(t);
    const player = frame(h.doc, 'ans-attach-online');
    player.setAttribute('src', '/ananas/modules/video/index.html?v=synthetic');
    player.contentDocument.open();
    player.contentDocument.write('<!doctype html><html><body></body></html>');
    player.contentDocument.close();
    const a = media(player.contentDocument);
    await h.start();
    assert.equal(a.state.calls, 1);
    assert.equal(h.app._active.task.kind, 'video');
});

// 即便附件没有明确视频标记，内部真实 video 也应优先于文档猜测。
test('actual video inside a generic attachment wins over document fallback', async t => {
    const h = harness(t);
    const player = frame(h.doc, 'ans-attach-online');
    const a = media(player.contentDocument);
    await h.start();
    assert.equal(a.state.calls, 1);
});

// 还没创建 video 的双重类别播放器只能等待，不能滚动播放器外壳。
test('uninitialized dual-class video waits for its media element', async t => {
    const h = harness(t);
    const player = frame(h.doc, 'ans-attach-online ans-insertvideo-online');
    player.contentDocument.body.innerHTML = '<p>播放器加载中，请稍候。</p>';
    await h.start();
    assert.equal(h.app._active, null);
    assert.match(h.app._message, /等待课程框架或下一个视频/);
    const a = media(player.contentDocument);
    await h.advance(250);
    assert.equal(a.state.calls, 1);
});

// 新默认值应允许四次每秒的真实滚动，但底部仍独立等待懒加载。
test('production defaults enable fast scrolling without reducing video save wait', t => {
    const dom = new JSDOM('<body></body>');
    dom.window.console.info = () => {};
    const app = createPlayer(dom.window);
    t.after(() => { app.destroy(); dom.window.close(); });
    assert.equal(app.configs.videoCheckInterval, 250);
    assert.equal(app.configs.documentDwellMs, 250);
    assert.equal(app.configs.documentBottomDwellMs, 1000);
    assert.equal(app.configs.settleMs, 8000);
});

// 确认上次滚动不再重新起算停留时间，避免实际速度比配置慢一倍。
test('fast document scroll advances every 250ms and waits at the bottom', async t => {
    const h = harness(t, tree, { documentDwellMs: 250, documentBottomDwellMs: 1000 });
    const document = scrollDocument(h.doc, 2000);
    await h.start();
    await h.advance(250);
    assert.equal(document.area.scrollTop, 500);
    await h.advance(250);
    assert.equal(document.area.scrollTop, 1000);
    await h.advance(250);
    assert.equal(document.area.scrollTop, 1500);
    await h.advance(250);
    assert.equal(h.app._completed.size, 0);
    await h.advance(750);
    assert.equal(h.app._completed.size, 0);
    await h.advance(250);
    assert.equal(h.app._completed.has(document.el), true);
});

// 快速翻页只在观察到准确新页码后继续，既不空等也不猜测成功。
test('fast pagination observes each page before clicking the next one', async t => {
    const h = harness(t, tree, { documentDwellMs: 250, documentBottomDwellMs: 1000 });
    const pdf = pagedDocument(h.doc);
    await h.start(); await h.advance(250);
    assert.equal(pdf.input.value, '2');
    await h.advance(250);
    assert.equal(pdf.input.value, '3');
    assert.equal(h.app._completed.size, 0);
    await h.advance(250);
    assert.equal(h.app._completed.size, 0);
    await h.advance(1000);
    assert.equal(h.app._completed.has(pdf.el), true);
});

// 同一 iframe 从已读文档变成待加载视频时，完成缓存不能跨类型复用。
test('completed document cannot mark a repurposed pending video as complete', async t => {
    const h = harness(t);
    const document = scrollDocument(h.doc, 500);
    await h.start(); await h.advance();
    assert.equal(h.app._completed.has(document.el), true);
    document.el.classList.add('ans-insertvideo-online');
    document.current.body.innerHTML = '<p>新播放器正在加载</p>';
    await h.advance(250);
    assert.match(h.app._message, /等待课程框架或下一个视频/);
    assert.equal(h.app._transition, null);
    const a = media(document.current);
    await h.advance(250);
    assert.equal(a.state.calls, 1);
});

// 默认对每个视频请求二倍速，不跳播放进度，释放后恢复各自原有速度。
test('defaults every queued video to 2x without seeking and restores original rates', async t => {
    const h = harness(t);
    const a = media(h.doc, 'a');
    const b = media(h.doc, 'b');
    a.el.playbackRate = 1.25;
    b.el.playbackRate = 1.5;
    a.state.currentTime = 12;
    let seekWrites = 0;
    Object.defineProperty(a.el, 'currentTime', {
        configurable: true,
        get: () => a.state.currentTime,
        // 记录是否有人直接修改进度，二倍速不应走这条路径。
        set(value) { seekWrites++; a.state.currentTime = value; },
    });
    await h.start();
    assert.equal(h.app.configs.playbackRate, 2);
    assert.equal(a.el.playbackRate, 2);
    assert.equal(a.el.currentTime, 12);
    a.end(); await h.advance(); await h.advance();
    assert.equal(b.el.playbackRate, 2);
    assert.equal(a.el.playbackRate, 1.25);
    assert.equal(seekWrites, 0);
    h.app.stop();
    assert.equal(b.el.playbackRate, 1.5);
});

// 点击真正的面板复选框应立即改变正在播放的视频，并可取消静音。
test('mute checkbox controls the active video immediately and restores its original state', async t => {
    const h = harness(t);
    const a = media(h.doc);
    a.el.muted = false;
    await h.start();
    const checkbox = h.app._panel.shadowRoot.getElementById('muted');
    assert.equal(checkbox.checked, false);
    checkbox.click();
    assert.equal(a.el.muted, true);
    assert.equal(h.app.configs.muted, true);
    assert.equal(a.state.calls, 1);
    checkbox.click();
    assert.equal(a.el.muted, false);
    checkbox.click();
    h.app.stop();
    assert.equal(a.el.muted, false);
    assert.equal(h.app.configs.muted, true);
});

// 启动前已开启的静音配置必须在 play 调用前应用，并沿用到下一视频。
test('enabled mute applies before playback and carries to the next video', async t => {
    const h = harness(t, tree, { muted: true });
    const a = media(h.doc, 'a');
    const b = media(h.doc, 'b');
    const muteAtPlay = [];
    for (const item of [a, b]) {
        item.el.muted = false;
        const play = item.el.play;
        // 捕获每次原生播放请求前的静音状态，防止先发声后静音。
        item.el.play = () => { muteAtPlay.push(item.el.muted); return play(); };
    }
    await h.start();
    assert.equal(h.app._panel.shadowRoot.getElementById('muted').checked, true);
    a.end(); await h.advance(); await h.advance();
    assert.deepEqual(muteAtPlay, [true, true]);
    assert.equal(a.el.muted, false);
    assert.equal(b.el.muted, true);
    h.app.stop();
    assert.equal(b.el.muted, false);
});

// 文档浏览或停止期间也能设置静音，设置不会改变运行状态或触发播放。
test('mute can be configured while stopped or browsing a document without starting media', async t => {
    const h = harness(t);
    pagedDocument(h.doc);
    h.app.setMuted(true);
    assert.equal(h.app._running, false);
    await h.start();
    assert.equal(h.app._active.task.kind, 'document');
    h.app._panel.shadowRoot.getElementById('muted').click();
    assert.equal(h.app.configs.muted, false);
    assert.equal(h.app._active.task.kind, 'document');
    assert.equal(h.app._running, true);
});

// 解除静音后若视频原本就是静音，停止时也必须恢复其原始静音状态。
test('stop restores an originally muted video after manual unmute', async t => {
    const h = harness(t, tree, { muted: true });
    const a = media(h.doc);
    a.el.muted = true;
    await h.start();
    h.app.setMuted(false);
    assert.equal(a.el.muted, false);
    h.app.stop();
    assert.equal(a.el.muted, true);
});

// 目录已明确确认整节完成时，不再重新播放该节视频。
test('confirmed completed unit advances before starting its video', async t => {
    const h = harness(t);
    const a = media(h.doc);
    completeUnit(h.doc);
    let clicks = 0;
    h.doc.querySelector('#unit2 .posCatalog_name').onclick = () => clicks++;
    await h.start(); await h.advance(250);
    assert.equal(a.state.calls, 0);
    assert.equal(clicks, 1);
});

// 已完成小节即使没有可识别媒体，也应根据明确的目录标记前进。
test('completed empty unit advances without waiting for nonexistent media', async t => {
    const h = harness(t);
    completeUnit(h.doc);
    let clicks = 0;
    h.doc.querySelector('#unit2 .posCatalog_name').onclick = () => clicks++;
    await h.start();
    assert.equal(clicks, 1);
});

// 空数量或零数量不等于平台已经确认完成，必须有明确的完成标记。
for (const value of ['', '0']) {
    test('unfinished count alone is not completion: ' + JSON.stringify(value), async t => {
        const h = harness(t);
        h.doc.getElementById('unit1').insertAdjacentHTML('beforeend', '<input class="jobUnfinishCount" value="' + value + '">');
        const a = media(h.doc);
        await h.start();
        assert.equal(a.state.calls, 1);
        assert.equal(h.app._transition, null);
    });
}

// 目录完成图标与正数待完成计数相矛盾时，不能跳过小节。
test('positive remaining task count blocks a conflicting completed icon', async t => {
    const h = harness(t);
    completeUnit(h.doc);
    h.doc.getElementById('unit1').insertAdjacentHTML('beforeend', '<span class="catalog_points_yi"><span class="prevHoverTips"><span class="orangeNew">2</span>个待完成任务点</span></span>');
    const a = media(h.doc);
    await h.start();
    assert.equal(a.state.calls, 1);
    assert.equal(h.app._transition, null);
});

// 其他小节或嵌套节点的完成标记不能用于当前小节。
test('completion markers are scoped to their own catalog node', async t => {
    const h = harness(t);
    completeUnit(h.doc, 'unit2');
    h.doc.getElementById('unit1').insertAdjacentHTML('beforeend', '<div class="posCatalog_select"><span class="icon_Completed">已完成</span></div>');
    const a = media(h.doc);
    await h.start();
    assert.equal(a.state.calls, 1);
    assert.equal(h.app._transition, null);
});

// 页面任务点仍未完成时，不允许只凭可能过时的目录完成图标跳走。
test('incomplete resource contradicts unit completion and is still played', async t => {
    const h = harness(t);
    completeUnit(h.doc);
    const a = media(h.doc);
    taskPoint(a.el, false);
    await h.start();
    assert.equal(a.state.calls, 1);
    assert.equal(h.app._transition, null);
});

// 同节只跳过已确认完成的视频，未完成的视频依然需要真实播放。
test('completed resource is skipped but unfinished sibling is played', async t => {
    const h = harness(t);
    const a = media(h.doc, 'a');
    const b = media(h.doc, 'b');
    taskPoint(a.el, true); taskPoint(b.el, false);
    await h.start();
    assert.equal(a.state.calls, 0);
    assert.equal(b.state.calls, 1);
    assert.equal(h.app._transition, null);
});

// 已完成的文档可以略过，即使当前浏览器不能读取它的阅读器。
test('confirmed completed document does not require reopening its reader', async t => {
    const h = harness(t);
    const document = frame(h.doc, 'ans-attach-online');
    taskPoint(document, true);
    const b = media(h.doc, 'b');
    taskPoint(b.el, false);
    await h.start();
    assert.equal(b.state.calls, 1);
    assert.equal(h.app._completed.has(document), true);
});

// 视频结束后不固定等八秒；平台确认一出现，下一次轮询就可接管下一视频。
test('ended video advances within one poll after its save marker confirms', async t => {
    const h = harness(t, tree, { settleMs: 8000, resourceTimeoutMs: 30000 });
    const a = media(h.doc, 'a');
    const b = media(h.doc, 'b');
    const point = taskPoint(a.el, false);
    taskPoint(b.el, false);
    await h.start(); a.end(); await h.advance(250);
    assert.equal(b.state.calls, 0);
    point.setComplete(true);
    await h.advance(250);
    assert.equal(b.state.calls, 1);
    assert.equal(h.app._transition, null);
});

// 当前页全部任务点已确认时，最后一个视频后不再追加整页八秒等待。
test('last confirmed video advances without a second fixed page wait', async t => {
    const h = harness(t, tree, { settleMs: 8000 });
    const a = media(h.doc);
    const point = taskPoint(a.el, false);
    let clicks = 0;
    h.doc.querySelector('#unit2 .posCatalog_name').onclick = () => clicks++;
    await h.start(); a.end(); point.setComplete(true); await h.advance(250);
    assert.equal(clicks, 1);
});

// 没有完成信号时只做一次原有保守等待，不能把等待时间算作平台确认。
test('unknown completion keeps one fallback wait rather than two', async t => {
    const h = harness(t, tree, { settleMs: 1000 });
    const a = media(h.doc);
    let clicks = 0;
    h.doc.querySelector('#unit2 .posCatalog_name').onclick = () => clicks++;
    await h.start(); a.end(); await h.advance(750);
    assert.equal(clicks, 0);
    await h.advance(250); await h.advance(250);
    assert.equal(clicks, 1);
});

// 已知未保存的任务点不能在固定等待到期后被当作成功并播放下一视频。
test('ended but unconfirmed task times out without playing the next resource', async t => {
    const h = harness(t, tree, { settleMs: 1000, resourceTimeoutMs: 2000 });
    const a = media(h.doc, 'a');
    const b = media(h.doc, 'b');
    taskPoint(a.el, false); taskPoint(b.el, false);
    await h.start(); a.end(); await h.advance(1000); await h.advance(1250);
    assert.equal(b.state.calls, 0);
    assert.equal(h.app._running, false);
    assert.match(h.app._message, /任务点尚未/);
});

// 部分任务提前达标时仍保留当前播放；整节未完成不能提早切走。
test('current video can finish naturally when only its point completes early', async t => {
    const h = harness(t);
    const a = media(h.doc, 'a');
    const b = media(h.doc, 'b');
    const point = taskPoint(a.el, false);
    taskPoint(b.el, false);
    await h.start(); point.setComplete(true); await h.advance(250);
    assert.equal(a.state.paused, false);
    assert.equal(b.state.calls, 0);
    a.end(); await h.advance(250);
    assert.equal(b.state.calls, 1);
});

// 资源外壳和无障碍文字短暂矛盾时不接受完成信号。
test('conflicting task completion signals never trigger early skipping', async t => {
    const h = harness(t);
    const a = media(h.doc);
    const point = taskPoint(a.el, false);
    point.wrapper.classList.add('ans-job-finished');
    await h.start();
    assert.equal(a.state.calls, 1);
    assert.equal(h.app._transition, null);
});

// 完成不能从内层另一个资源借用；必须对应当前任务外壳。
test('nested completed attachment cannot complete an unfinished outer task', async t => {
    const h = harness(t);
    const a = media(h.doc);
    const point = taskPoint(a.el, false);
    point.wrapper.insertAdjacentHTML('beforeend', '<div class="ans-attach-ct ans-job-finished"><div class="ans-job-icon" aria-label="任务点已完成"></div></div>');
    await h.start();
    assert.equal(a.state.calls, 1);
});

// 即使未识别成媒体，页面中的待完成任务点仍须阻止自动离开。
test('unhandled visible task point blocks page completion after media is saved', async t => {
    const h = harness(t);
    const a = media(h.doc);
    const point = taskPoint(a.el, false);
    h.doc.body.insertAdjacentHTML('beforeend', '<div class="ans-attach-ct"><div class="ans-job-icon" aria-label="任务点未完成"></div></div>');
    let clicks = 0;
    h.doc.querySelector('#unit2 .posCatalog_name').onclick = () => clicks++;
    await h.start(); a.end(); point.setComplete(true); await h.advance(250); await h.advance(6000);
    assert.equal(clicks, 0);
    assert.equal(h.app._running, false);
});

// 用户关闭自动切换时，已完成小节也不能触发目录点击。
test('completed unit respects disabled automatic navigation', async t => {
    const h = harness(t, tree, { autoplay: false });
    completeUnit(h.doc);
    const a = media(h.doc);
    await h.start();
    assert.equal(a.state.calls, 0);
    assert.equal(h.app._running, false);
    assert.equal(h.app._transition, null);
});

// 从空页或待加载页切节后，旧内容框架里迟到的视频不能被当作新小节视频。
for (const initiallyEmpty of [true, false]) {
    test('old course frame cannot supply a late video after navigation: empty=' + initiallyEmpty, async t => {
        const h = harness(t);
        const oldFrame = frame(h.doc);
        oldFrame.id = 'iframe';
        if (!initiallyEmpty) oldFrame.contentDocument.body.innerHTML = '<p>旧小节正文</p>';
        completeUnit(h.doc);
        h.doc.querySelector('#unit2 .posCatalog_name').onclick = () => {
            h.doc.getElementById('unit1').classList.remove('posCatalog_active');
            h.doc.getElementById('unit2').classList.add('posCatalog_active');
        };
        await h.start();
        const stale = media(oldFrame.contentDocument, 'late-old');
        await h.advance(2000);
        assert.equal(stale.state.calls, 0);
        assert.ok(h.app._transition);
        oldFrame.remove();
        const newFrame = frame(h.doc);
        newFrame.id = 'iframe';
        const next = media(newFrame.contentDocument, 'new-course');
        await h.advance(250);
        assert.equal(next.state.calls, 1);
    });
}

// 用户手动切换目录但内容尚未更新时，旧完成标记不能导致再跳过新小节。
test('manual catalog switch cannot reuse completion from the previous content', async t => {
    const h = harness(t);
    h.doc.querySelector('#coursetree li').insertAdjacentHTML('beforeend', '<div class="posCatalog_select" id="unit3"><span class="posCatalog_name">单元三</span></div>');
    const a = media(h.doc, 'old');
    const point = taskPoint(a.el, false);
    let skipped = 0;
    h.doc.querySelector('#unit3 .posCatalog_name').onclick = () => skipped++;
    await h.start();
    point.setComplete(true);
    h.doc.getElementById('unit1').classList.remove('posCatalog_active');
    h.doc.getElementById('unit2').classList.add('posCatalog_active');
    await h.advance(250);
    assert.equal(skipped, 0);
    assert.ok(h.app._transition);
    assert.equal(a.state.paused, true);
    point.wrapper.remove();
    const b = media(h.doc, 'new');
    taskPoint(b.el, false);
    await h.advance(1500);
    assert.equal(b.state.calls, 1);
    assert.equal(h.app._unit.id, 'unit2');
});

// 无关 iframe 加载不能证明课程内容已切换，旧播放器仍在时必须继续等待。
test('unrelated frame loading does not confirm navigation while the old media remains', async t => {
    const h = harness(t);
    const a = media(h.doc, 'old');
    h.doc.querySelector('#unit2 .posCatalog_name').onclick = () => {
        h.doc.getElementById('unit1').classList.remove('posCatalog_active');
        h.doc.getElementById('unit2').classList.add('posCatalog_active');
    };
    await h.start(); a.end(); await h.advance(); await h.advance();
    frame(h.doc).contentDocument.body.innerHTML = '<p>无关的侧边栏内容</p>';
    await h.advance(2000);
    assert.ok(h.app._transition);
    assert.equal(a.state.calls, 1);
    a.el.remove();
    const b = media(h.doc, 'new');
    await h.advance(250);
    assert.equal(b.state.calls, 1);
});

// 同一小节的目录元素重建，不代表用户切换了小节，不能暂停正在播放的视频。
test('catalog redraw with the same unit id does not pause playback', async t => {
    const h = harness(t);
    const a = media(h.doc);
    await h.start();
    const generation = h.app._generation;
    const old = h.doc.getElementById('unit1');
    old.replaceWith(old.cloneNode(true));
    await h.advance(250);
    assert.equal(a.state.paused, false);
    assert.equal(a.state.calls, 1);
    assert.equal(h.app._transition, null);
    assert.equal(h.app._generation, generation);
    assert.equal(h.app._unit, h.doc.getElementById('unit1'));
});

// 自动跳转期间目录重绘后仍应认出目标小节，而不是永久等旧 DOM 对象。
test('navigation target survives catalog replacement', async t => {
    const h = harness(t);
    const a = media(h.doc, 'old');
    let b;
    h.doc.querySelector('#unit2 .posCatalog_name').onclick = () => {
        h.doc.getElementById('unit1').classList.remove('posCatalog_active');
        const selected = h.doc.getElementById('unit2');
        selected.classList.add('posCatalog_active');
        selected.replaceWith(selected.cloneNode(true));
        a.el.remove(); b = media(h.doc, 'new');
    };
    await h.start(); a.end(); await h.advance(); await h.advance(); await h.advance(1500);
    assert.equal(b.state.calls, 1);
    assert.equal(h.app._transition, null);
});

// 已完成的连续小节只需一次跳到首个未完成小节，且延迟标题更新不应再次暂停。
test('skips five completed units in one navigation and ignores late heading updates', async t => {
    const h = harness(t, tree + '<div class="prev_title" title="旧章节标题">旧章节标题</div>');
    for (let i = 3; i <= 6; i++) h.doc.querySelector('#coursetree li').insertAdjacentHTML('beforeend', '<div class="posCatalog_select" id="unit' + i + '"><span class="posCatalog_name">单元' + i + '</span></div>');
    for (let i = 1; i <= 5; i++) completeUnit(h.doc, 'unit' + i);
    let content = coursePage(h.doc, 101);
    const clicked = [];
    let currentVideo;
    for (const node of h.doc.querySelectorAll('.posCatalog_select')) {
        // 原生点击响应会刷新目录对象和内容框架，但保持每节的稳定编号。
        node.querySelector('.posCatalog_name').onclick = () => {
            clicked.push(node.id);
            h.doc.querySelector('.posCatalog_active').classList.remove('posCatalog_active');
            node.classList.add('posCatalog_active');
            const next = node.cloneNode(true); node.replaceWith(next);
            content.remove(); content = coursePage(h.doc, Number(next.id.replace('unit', '')));
            currentVideo = media(content.contentDocument, 'current');
            if (next.id !== 'unit6') taskPoint(currentVideo.el, true);
        };
    }
    await h.start(); await h.advance(1500);
    assert.deepEqual(clicked, ['unit6']);
    assert.equal(currentVideo.state.calls, 1);
    const title = h.doc.querySelector('.prev_title');
    title.title = '新章节标题'; title.textContent = '新章节标题';
    await h.advance(2500);
    const selected = h.doc.getElementById('unit6'); selected.replaceWith(selected.cloneNode(true));
    await h.advance(250);
    assert.equal(currentVideo.state.paused, false);
    assert.equal(currentVideo.state.calls, 1);
    assert.equal(h.app._transition, null);
});

// 标题或提示子节点的重新渲染不应被当作学习步骤切换。
test('step tooltip and whitespace changes do not restart the active video', async t => {
    const h = harness(t, tree + '<span class="prev_title" title="视频">2 视频<span class="hint">提示</span></span>');
    const a = media(h.doc);
    await h.start();
    h.doc.querySelector('.hint').textContent = '提示已经更新';
    h.doc.querySelector('.prev_title').firstChild.textContent = '  2   视频  ';
    await h.advance(250);
    assert.equal(a.state.paused, false);
    assert.equal(h.app._transition, null);
});

// 目标目录已选中但课程框架加载了另一节时，不能播放错误小节的媒体。
test('loaded chapter must match the selected stable chapter id', async t => {
    const h = harness(t);
    h.doc.getElementById('unit1').id = 'cur101';
    h.doc.getElementById('unit2').id = 'cur102';
    let content = coursePage(h.doc, 101);
    completeUnit(h.doc, 'cur101');
    let wrong;
    h.doc.querySelector('#cur102 .posCatalog_name').onclick = () => {
        h.doc.getElementById('cur101').classList.remove('posCatalog_active');
        h.doc.getElementById('cur102').classList.add('posCatalog_active');
        content.remove(); content = coursePage(h.doc, 103);
        wrong = media(content.contentDocument, 'wrong-chapter');
    };
    await h.start(); await h.advance(1500);
    assert.equal(wrong.state.calls, 0);
    assert.ok(h.app._transition);
    content.remove(); content = coursePage(h.doc, 102);
    const correct = media(content.contentDocument, 'correct-chapter');
    await h.advance(250);
    assert.equal(correct.state.calls, 1);
});

// 同一文档局部换课时，已加载地址和资源都已变化就足以确认，不必重建 iframe。
test('reused course document can confirm a new loaded chapter after resource replacement', async t => {
    const h = harness(t);
    h.doc.getElementById('unit1').id = 'cur101';
    h.doc.getElementById('unit2').id = 'cur102';
    const content = coursePage(h.doc, 101);
    const a = media(content.contentDocument, 'old');
    let b;
    // 模拟局部路由：保留文档对象，但更新实际文档地址并替换播放器。
    h.doc.querySelector('#cur102 .posCatalog_name').onclick = () => {
        h.doc.getElementById('cur101').classList.remove('posCatalog_active');
        h.doc.getElementById('cur102').classList.add('posCatalog_active');
        content.contentWindow.history.replaceState(null, '', '?knowledgeid=102&num=0');
        a.el.remove(); b = media(content.contentDocument, 'new');
    };
    await h.start(); h.app.nextUnit(); await h.advance(1500);
    assert.equal(b.state.calls, 1);
    assert.equal(h.app._transition, null);
    assert.equal(h.app._unitKey, 'chapter:102');
});

// 同一小节的真实卡片切换必须清空旧完成缓存，即使视频地址相同也重新接管。
test('real loaded card changes reset completion in a reused course document', async t => {
    const h = harness(t);
    h.doc.getElementById('unit1').id = 'cur101';
    const content = coursePage(h.doc, 101, 0);
    const a = media(content.contentDocument, 'same-source');
    await h.start(); a.end(); await h.advance();
    assert.ok(h.app._completed.has(a.el));
    a.el.remove();
    content.contentWindow.history.replaceState(null, '', '?knowledgeid=101&num=1');
    const b = media(content.contentDocument, 'same-source');
    await h.advance(250); await h.advance(1500);
    assert.equal(b.state.calls, 1);
    assert.equal(h.app._stepKey, 'card:1');
    assert.equal(h.app._completed.has(a.el), false);
    assert.equal(h.app._transition, null);
});

// 只改框架 src 不代表实际文档已换课，即使旧正文重建也不能接管错误内容。
test('changed frame src cannot substitute for a loaded chapter change', async t => {
    const h = harness(t);
    h.doc.getElementById('unit1').id = 'cur101';
    h.doc.getElementById('unit2').id = 'cur102';
    const content = coursePage(h.doc, 101);
    const originalDocument = content.contentDocument;
    const a = media(originalDocument, 'old');
    // 保留真实旧文档，模拟网络加载期间 src 已变而 document 尚未替换。
    Object.defineProperty(content, 'contentDocument', { configurable: true, get: () => originalDocument });
    await h.start(); h.app.nextUnit();
    h.doc.getElementById('cur101').classList.remove('posCatalog_active');
    h.doc.getElementById('cur102').classList.add('posCatalog_active');
    content.setAttribute('src', '/mooc-ans/knowledge/cards?knowledgeid=102&num=0');
    a.el.remove();
    const stale = media(originalDocument, 'late-old');
    await h.advance(1500);
    assert.equal(stale.state.calls, 0);
    assert.ok(h.app._transition);
});

// 实际地址已改变但旧播放器还在，也必须等待资源替换，不能只凭编号放行。
test('loaded chapter changes cannot take ownership of the old remaining video', async t => {
    const h = harness(t);
    h.doc.getElementById('unit1').id = 'cur101';
    h.doc.getElementById('unit2').id = 'cur102';
    const content = coursePage(h.doc, 101);
    const a = media(content.contentDocument, 'old');
    await h.start(); h.app.nextUnit();
    h.doc.getElementById('cur101').classList.remove('posCatalog_active');
    h.doc.getElementById('cur102').classList.add('posCatalog_active');
    content.contentWindow.history.replaceState(null, '', '?knowledgeid=102&num=0');
    await h.advance(1500);
    assert.equal(a.state.calls, 1);
    assert.equal(a.state.paused, true);
    assert.ok(h.app._transition);
    a.el.remove();
    const b = media(content.contentDocument, 'new');
    await h.advance(250);
    assert.equal(b.state.calls, 1);
});

// 多个可见课程框架归属冲突时保持等待；旧框架消失后才接管唯一正确内容。
test('conflicting visible course frames wait until the stale frame is removed', async t => {
    const h = harness(t);
    h.doc.getElementById('unit1').id = 'cur101';
    h.doc.getElementById('unit2').id = 'cur102';
    const old = coursePage(h.doc, 101);
    media(old.contentDocument, 'old');
    await h.start(); h.app.nextUnit();
    h.doc.getElementById('cur101').classList.remove('posCatalog_active');
    h.doc.getElementById('cur102').classList.add('posCatalog_active');
    const current = coursePage(h.doc, 102);
    const b = media(current.contentDocument, 'new');
    await h.advance(1500);
    assert.equal(b.state.calls, 0);
    assert.ok(h.app._transition);
    old.remove(); await h.advance(250);
    assert.equal(b.state.calls, 1);
    assert.equal(h.app._transition, null);
});

// 目标编号重复时拒绝点击，不能由同名目标中猜一个继续。
test('duplicate catalog target identities stop without clicking', async t => {
    const h = harness(t);
    completeUnit(h.doc);
    const target = h.doc.getElementById('unit2');
    target.after(target.cloneNode(true));
    let clicks = 0;
    // 记录合成目录事件，确保拒绝歧义时没有实际点击。
    h.doc.getElementById('coursetree').addEventListener('click', () => clicks++);
    await h.start();
    assert.equal(h.app._running, false);
    assert.equal(clicks, 0);
    assert.match(h.app._message, /编号不唯一/);
});

// 完成链中的图标与待完成计数矛盾时，必须在该小节停下而不是整链跳过。
test('completed chains stop at a conflicting pending count', async t => {
    const h = harness(t);
    h.doc.querySelector('#coursetree li').insertAdjacentHTML('beforeend', '<div class="posCatalog_select" id="unit3"><span class="posCatalog_name">单元三</span></div>');
    completeUnit(h.doc, 'unit1'); completeUnit(h.doc, 'unit2');
    h.doc.getElementById('unit2').insertAdjacentHTML('beforeend', '<input class="jobUnfinishCount" value="1">');
    const clicked = [];
    // 只记录选择结果，不真正加载课程。
    h.doc.getElementById('coursetree').addEventListener('click', event => clicked.push(event.target.closest('.posCatalog_select').id));
    await h.start();
    assert.deepEqual(clicked, ['unit2']);
});

// 收起只改变面板布局，不改变播放、计时器或用户设置；紧急停止仍可直接操作。
test('panel collapses without interrupting playback and keeps stop accessible', async t => {
    const h = harness(t, tree, { muted: true });
    const a = media(h.doc);
    await h.start();
    const shadow = h.app._panel.shadowRoot;
    const toggle = shadow.getElementById('collapse');
    assert.ok(toggle);
    const generation = h.app._generation;
    toggle.click();
    assert.equal(shadow.getElementById('panel-body').hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.getAttribute('aria-label'), '展开面板');
    assert.equal(h.app._panel.style.width, '208px');
    assert.equal(shadow.getElementById('panel-body').contains(shadow.getElementById('stop')), false);
    assert.equal(a.state.paused, false);
    assert.equal(h.app._generation, generation);
    assert.equal(h.intervals.size, 1);
    shadow.getElementById('stop').click();
    assert.equal(a.state.paused, true);
    assert.equal(h.app._running, false);
    toggle.click();
    assert.equal(shadow.getElementById('panel-body').hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(h.app._panel.style.width, '320px');
    assert.equal(shadow.getElementById('muted').checked, true);
});

// 重复展开/收起不得叠加事件或轮询，折叠状态的标题仍可查看完整状态。
test('repeated collapse controls are idempotent and status stays discoverable', async t => {
    const h = harness(t);
    media(h.doc);
    await h.start();
    for (let i = 0; i < 5; i++) { h.app.setCollapsed(true); h.app.setCollapsed(false); }
    h.app.setCollapsed(true);
    h.app._status('合成状态：等待内容加载');
    assert.equal(h.app._panel.shadowRoot.querySelector('strong').title, '合成状态：等待内容加载');
    assert.equal(h.app._panel.shadowRoot.querySelectorAll('#collapse').length, 1);
    assert.equal(h.intervals.size, 1);
    assert.equal(h.app._running, true);
});
