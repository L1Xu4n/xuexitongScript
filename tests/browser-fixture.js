// 在页面中显示实际观察到的事件，供浏览器检查资源处理顺序。
function record(label) {
    const row = document.createElement('li');
    row.textContent = label;
    document.getElementById('events').appendChild(row);
}

// 录制两秒 canvas 动画作为真正的 HTML5 视频，不下载或访问远程媒体。
async function makeClip() {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    // 录制结束后构造本机 Blob，浏览器正常解码并触发 ended 事件。
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    let frame = 0;
    // 绘制可见的帧号和移动矩形，便于识别空白或不前进的画面。
    function draw() {
        context.fillStyle = '#176b51'; context.fillRect(0, 0, 320, 180);
        context.fillStyle = '#f9cd66'; context.fillRect((frame * 12) % 280, 90, 40, 40);
        context.fillStyle = '#ffffff'; context.font = '26px sans-serif';
        context.fillText('LOCAL VIDEO ' + frame, 20, 55);
        frame++;
    }
    draw(); recorder.start();
    const timer = setInterval(draw, 100);
    await new Promise(resolve => setTimeout(resolve, 2100));
    clearInterval(timer); recorder.stop(); await stopped;
    for (const track of stream.getTracks()) track.stop();
    return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
}

// 创建真实播放器并只记录自然结束，绝不在测试里强制跳到媒体末尾。
function addVideo(parent, source, label) {
    const video = document.createElement('video');
    video.controls = true;
    video.muted = true;
    video.src = source;
    video.setAttribute('aria-label', label);
    video.addEventListener('ended', () => record(label + '自然结束'));
    parent.appendChild(video);
    return video;
}

// 布置“视频一 → 三页文档 → 视频二 → 下一小节”的实际浏览器测试。
async function setupFixture() {
    const source = await makeClip();
    const resources = document.getElementById('resources');
    addVideo(resources, source, '视频一');
    const frame = document.createElement('iframe');
    frame.className = 'ans-attach-online';
    frame.title = '合成文档';
    // srcdoc 继承本页源，模拟可被正常访问的文档阅读器。
    const loaded = new Promise(resolve => { frame.onload = resolve; });
    frame.srcdoc = '<!doctype html><html><body><h2>合成文档</h2><input id="pageNumber" value="1" readonly size="2" aria-label="当前页"><span id="numPages">共 3 页</span><button id="next">下一页</button><p>仅用于本地回归验证。</p></body></html>';
    resources.appendChild(frame);
    await loaded;
    const number = frame.contentDocument.getElementById('pageNumber');
    // 页面自身响应下一页按钮并改变页码，与脚本的判断逻辑相互独立。
    frame.contentDocument.getElementById('next').onclick = () => {
        number.value = String(Math.min(3, Number(number.value) + 1));
        record('文档第' + number.value + '页');
    };
    addVideo(resources, source, '视频二');
    // 模拟目录原生切换结果，测试结束后停止助手以免继续空页等待。
    document.querySelector('#second-unit .posCatalog_name').onclick = () => {
        document.getElementById('first-unit').classList.remove('posCatalog_active');
        document.getElementById('second-unit').classList.add('posCatalog_active');
        record('切换到第二小节');
        document.getElementById('result').textContent = '本地流程结束，请核对事件顺序';
        window.app.stop('本地验证结束');
    };
    const script = document.createElement('script');
    script.src = '../v3_optimized.user.js';
    // 缩短的仅是本地测试等待时间，交付脚本的默认配置保持不变。
    script.onload = () => {
        window.app.configs.settleMs = 300;
        window.app.configs.documentDwellMs = 1000;
        document.getElementById('result').textContent = '本地流程运行中';
    };
    document.head.appendChild(script);
    window.addEventListener('pagehide', () => URL.revokeObjectURL(source), { once: true });
}

// 在不支持媒体录制或本地加载失败时显示明确的测试失败信息。
setupFixture().catch(error => {
    document.getElementById('result').textContent = '本地测试失败：' + error.name;
});
