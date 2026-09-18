// 衍生自 chaolucky18/xuexitongScript，感谢原作者与贡献者；来源与许可状态见 NOTICE.md。
// 视频与文档优化版本由 L1Xu4n 维护：https://github.com/L1Xu4n/xuexitongScript
// 启动同一份控制台/油猴代码；子框架不重复启动，重复注入先清理旧实例。
(function bootstrap(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory;
        return;
    }
    if (root.top !== root.self) return;
    const key = '__xuexitongPlayerV3';
    root.document.dispatchEvent(new root.Event('xuexitong-helper-dispose'));
    root[key]?.destroy();
    root[key] = factory(root);
    root.app = root[key];
    root[key].run();
})(typeof window === 'undefined' ? globalThis : window, function createPlayer(win, options = {}) {
    const doc = win.document;
    const now = options.now || Date.now;

    // 统一标签文字，兼容“2 视频”和“视频”等页面标题。
    function text(value) {
        return String(value || '').replace(/\s+/g, '').replace(/^\d+[.、]?/, '');
    }

    // 只排除真正隐藏的节点，不把屏幕下方尚未滚到的视频排除。
    function visible(element) {
        if (!element?.isConnected) return false;
        for (let node = element; node; node = node.parentElement) {
            const style = node.ownerDocument.defaultView.getComputedStyle(node);
            if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
    }

    // 单独捕获每个 iframe 的同源访问错误，避免一个无关框架阻断全部扫描。
    function frameDocument(frame) {
        try {
            return frame.contentDocument || frame.contentWindow?.document || null;
        } catch {
            return null;
        }
    }

    // 视频常与文档共用 ans-attach-online；专用视频类别和模块路径必须优先。
    function videoFrame(frame) {
        const path = (frame.getAttribute('src') || '').split(/[?#]/)[0];
        return frame.matches('.ans-insertvideo-online') || /\/modules\/video\//i.test(path);
    }

    // 辨认非视频的文档候选，只读取路径，不输出可能含认证参数的完整 URL。
    function documentFrame(frame) {
        if (videoFrame(frame)) return false;
        const path = (frame.getAttribute('src') || '').split(/[?#]/)[0];
        return frame.matches('.ans-attach-online') ||
            /\/modules\/(?:pdf|ppt|doc|document|book)\//i.test(path) || /\.(?:pdf|pptx?|docx?)$/i.test(path);
    }

    // 识别尚未加载的课程/视频框架，它们不能被当成“没有任务”。
    function resourceFrame(frame) {
        return frame.matches('#iframe, #contentIframe, .ans-insertvideo-online, .ans-attach-online') ||
            /\/knowledge\/cards|\/ananas\/|\/video\//i.test(frame.getAttribute('src') || '');
    }

    // 从视频或文档向上查找任务点外壳，只读平台的完成标记。
    function taskWrapper(element) {
        let node = element;
        while (node) {
            const wrapper = node.closest?.('.ans-attach-ct');
            if (wrapper) return wrapper;
            try { node = node.ownerDocument.defaultView.frameElement; } catch { return null; }
        }
        return null;
    }

    // 读取单个任务点：true=平台已确认，false=仍未完成，null=没有可靠标记。
    function taskPointState(wrapper) {
        if (!wrapper) return null;
        const icons = wrapper.matches('.ans-job-icon') ? [wrapper] :
            Array.from(wrapper.querySelectorAll('.ans-job-icon')).filter(icon =>
                icon.closest('.ans-attach-ct') === wrapper && visible(icon));
        const labels = icons.map(icon => text(icon.getAttribute('aria-label') || icon.getAttribute('title')));
        if (labels.some(label => /^(任务点)?未完成$/.test(label))) return false;
        if (wrapper.classList.contains('ans-job-finished')) return true;
        if (icons.length) return labels.every(label => /^(任务点)?已完成$/.test(label));
        return null;
    }

    // 缓存键由 DOM 元素、资源类型和地址共同决定，文档记录不能套用到视频。
    function fingerprint(task) {
        if (task.kind === 'video') {
            return 'video:' + (task.element.currentSrc || task.element.getAttribute('src') ||
                task.element.querySelector('source')?.getAttribute('src') || '');
        }
        return task.kind + ':' + (task.element.getAttribute('src') || '');
    }

    // 获取资源实际所属内容文档，区分同一个 iframe 外壳中的新旧页面。
    function resourceDocument(task) {
        return task.element.tagName === 'IFRAME' ? frameDocument(task.element) : task.element.ownerDocument;
    }

    // 只从已加载的课程文档地址读取小节/卡片编号，不使用尚未加载的 src 证明切换。
    function courseContext(current) {
        try {
            const url = new win.URL(current?.URL || '');
            if (!/\/knowledge\/cards$/.test(url.pathname)) return null;
            const chapter = url.searchParams.get('knowledgeid');
            const card = url.searchParams.get('num') || '0';
            return { chapter: /^\d+$/.test(chapter || '') ? chapter : null, card: /^\d+$/.test(card) ? card : null };
        } catch {
            return null;
        }
    }

    // 固定导航前的资源与课程框架身份，避免后续 DOM 变化改写比较依据。
    function navigationSnapshot(snapshot) {
        return {
            tasks: snapshot.tasks.map(task => ({
                element: task.element, kind: task.kind, source: fingerprint(task),
                document: resourceDocument(task), ended: task.kind === 'video' && task.element.ended,
            })),
            documents: snapshot.documents,
            courseFrames: snapshot.courseFrames,
        };
    }

    // 深度优先、按页面顺序收集所有资源，保留未加载资源的位置。
    function scanResources() {
        const tasks = [];
        const documents = [];
        const courseFrames = [];
        const visited = new Set();
        // 在同源子页面内继续扫描；深度上限防止异常框架树占满调用栈。
        function visit(current, depth) {
            if (!current || visited.has(current)) return;
            visited.add(current);
            documents.push(current);
            for (const element of current.querySelectorAll('video, iframe')) {
                if (!visible(element)) continue;
                if (element.tagName === 'VIDEO') {
                    tasks.push({ kind: 'video', element });
                    continue;
                }
                const child = frameDocument(element);
                // 目录切换时，课程内容框架的文档身份是比等待秒数更可靠的依据。
                if (element.matches('#iframe, #contentIframe') || /\/knowledge\/cards(?:[/?#]|$)/.test(element.getAttribute('src') || '')) {
                    courseFrames.push({ element, document: child, context: courseContext(child) });
                }
                const videoContainer = videoFrame(element) || (child &&
                    Array.from(child.querySelectorAll('video, iframe.ans-insertvideo-online, iframe[src*="/modules/video/"]')).some(visible));
                if (!videoContainer && (documentFrame(element) || child?.querySelector('#viewerContainer .pdfViewer'))) {
                    tasks.push({ kind: 'document', element });
                    continue;
                }
                const before = tasks.length;
                if (depth < 8) visit(child, depth + 1);
                const candidate = resourceFrame(element) || element.closest('.ans-attach-ct') ||
                    (child && !element.getAttribute('src'));
                if (tasks.length === before && candidate &&
                    (!child?.body || child.readyState === 'loading' || !child.body.childElementCount ||
                        videoContainer || child.querySelector('.ans-attach-ct'))) {
                    tasks.push({ kind: 'pending', element });
                }
            }
        }
        visit(doc, 0);
        return { tasks, documents, courseFrames };
    }

    // 仅在明确的可见弹窗/验证控件中找阻塞信息，不扫描整页课程正文。
    function blocker(documents) {
        for (const current of documents) {
            for (const el of current.querySelectorAll('[role="dialog"], .layui-layer, .yidun_panel, .geetest_panel, #captcha')) {
                if (!visible(el)) continue;
                if (el.matches('.yidun_panel, .geetest_panel, #captcha') ||
                    /验证|验证码|人脸|登录|登陆|未完成|测验|答题|请求失败|网络异常/.test(el.textContent)) {
                    return '检测到验证、登录、测验或未完成提示，请手动处理后点击开始。';
                }
            }
        }
        return '';
    }

    const app = {
        configs: {
            playbackRate: 2,
            autoplay: true,
            muted: false,
            mutedFallback: true,
            retryInterval: 2000,
            maxRetries: 10,
            videoCheckInterval: 250,
            startupTimeoutMs: 60000,
            resourceTimeoutMs: 30000,
            playTimeoutMs: 15000,
            stallTimeoutMs: 45000,
            settleMs: 8000,
            documentDwellMs: 250,
            documentBottomDwellMs: 1000,
            documentMaxMs: 1800000,
            autoReadDocuments: true,
        },
        _running: false,
        _generation: 0,
        _timer: null,
        _active: null,
        _completed: new Map(),
        _transition: null,
        _lastSnapshot: null,
        _unit: null,
        _unitKey: null,
        _step: '',
        _stepKey: '',
        _owner: win.crypto?.randomUUID?.() || String(Math.random()),
        _startedAt: 0,
        _waitingSince: 0,
        _emptySince: null,
        _panel: null,
        _collapsed: false,
        _message: '',

        // 创建可收起的面板；停止按钮留在标题栏，收起后仍可直接操作。
        _mountPanel() {
            if (this._panel?.isConnected || !doc.body) return;
            const host = doc.createElement('div');
            host.id = 'xuexitong-helper-panel';
            host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:calc(100vw - 24px);width:320px;';
            const shadow = host.attachShadow({ mode: 'open' });
            shadow.innerHTML = [
                '<style>:host{all:initial}[hidden]{display:none!important}section{box-sizing:border-box;background:#fff;color:#17251e;border:1px solid #8caaa0;border-radius:6px;padding:8px;font:14px/1.6 system-ui}',
                'header{display:flex;align-items:center;gap:6px}strong{font-size:14px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}small{font-size:11px;color:#526c60}:host([data-collapsed]) small{display:none}',
                'p{margin:8px 0;overflow-wrap:anywhere}label{display:flex;align-items:center;gap:6px;margin:4px 0 8px}input[type=checkbox]{margin:0}button{font:inherit;padding:3px 12px;cursor:pointer;border:1px solid #678577;border-radius:4px;background:#f0f6f3;color:#17251e}',
                'button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:2px solid #166a47;outline-offset:2px}#stop{flex:none;padding:2px 8px}.icon{width:28px;height:28px;flex:none;padding:0;display:grid;place-items:center}.icon svg{width:18px;height:18px}</style>',
                '<section><header><strong>学习通助手 <small>3.4.4</small></strong><button type="button" id="stop">停止</button>',
                '<button type="button" id="collapse" class="icon" aria-label="收起面板" title="收起面板" aria-expanded="true" aria-controls="panel-body"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></header>',
                '<div id="panel-body"><p role="status" aria-live="polite"></p><label><input type="checkbox" id="muted">静音播放</label><button type="button" id="start">开始</button></div></section>',
            ].join('');
            shadow.getElementById('start').addEventListener('click', this._onStart);
            shadow.getElementById('stop').addEventListener('click', this._onStop);
            shadow.getElementById('muted').checked = this.configs.muted;
            shadow.getElementById('muted').addEventListener('change', this._onMuteChange);
            shadow.getElementById('collapse').addEventListener('click', this._onCollapse);
            doc.body.appendChild(host);
            this._panel = host;
            this.setCollapsed(this._collapsed);
            this._status(this._message || '等待课程页面加载');
        },

        // 只收起/展开面板显示，不改变播放状态、计时器或静音选项。
        setCollapsed(collapsed) {
            this._collapsed = Boolean(collapsed);
            if (!this._panel) return;
            const shadow = this._panel.shadowRoot;
            const body = shadow.getElementById('panel-body');
            const button = shadow.getElementById('collapse');
            if (this._collapsed && body.contains(shadow.activeElement)) button.focus();
            body.hidden = this._collapsed;
            this._panel.toggleAttribute('data-collapsed', this._collapsed);
            this._panel.style.width = this._collapsed ? '208px' : '320px';
            button.setAttribute('aria-expanded', String(!this._collapsed));
            button.setAttribute('aria-label', this._collapsed ? '展开面板' : '收起面板');
            button.title = this._collapsed ? '展开面板' : '收起面板';
            // Lucide ChevronUp/ChevronDown 原始路径；版权许可保留在源码末尾。
            button.querySelector('path').setAttribute('d', this._collapsed ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6');
        },

        // 切换本页的静音偏好，立即作用于当前视频，后续视频也会沿用。
        setMuted(enabled) {
            this.configs.muted = Boolean(enabled);
            const checkbox = this._panel?.shadowRoot.getElementById('muted');
            if (checkbox) checkbox.checked = this.configs.muted;
            if (this._active?.task.kind === 'video') this._active.task.element.muted = this.configs.muted;
        },

        // 更新面板，状态变更时才输出日志，日志不包含资源 URL 或身份信息。
        _status(message) {
            if (message !== this._message) win.console.info('[学习通助手]', message);
            this._message = message;
            const shadow = this._panel?.shadowRoot;
            if (!shadow) return;
            shadow.querySelector('[role="status"]').textContent = message;
            shadow.querySelector('strong').title = message;
            shadow.getElementById('start').disabled = this._running;
            shadow.getElementById('stop').disabled = !this._running;
        },

        // 启动一个新的有限状态轮询，旧异步播放结果会因代数变化而失效。
        run() {
            this.stop('正在启动');
            this._running = true;
            this._startedAt = now();
            this._waitingSince = now();
            this._emptySince = null;
            this._transition = null;
            this._mountPanel();
            this._status('已启动，正在识别当前小节');
            this._timer = win.setInterval(this.tick.bind(this), this.configs.videoCheckInterval);
            this.tick();
        },

        // 停止所有自动操作并使未完成的 play() 回调失效，保留当前页浏览记录。
        stop(message = '已停止') {
            this._running = false;
            this._generation++;
            if (this._timer !== null) win.clearInterval(this._timer);
            this._timer = null;
            this._transition = null;
            this._releaseActive();
            this._status(message);
        },

        // 释放当前媒体监听并恢复被助手修改的静音和倍速设置。
        _releaseActive() {
            const active = this._active;
            this._active = null;
            if (active?.task.kind !== 'video') return;
            const video = active.task.element;
            video.removeEventListener('ended', active.onEnded);
            video.removeEventListener('error', active.onError);
            video.pause();
            video.muted = active.oldMuted;
            video.playbackRate = active.oldRate;
            if (video.getAttribute('data-xuexitong-helper-owner') === active.owner) video.removeAttribute('data-xuexitong-helper-owner');
        },

        // 销毁整个实例，重复注入和离开页面都不会遗留计时器或面板。
        destroy() {
            this.stop('实例已关闭');
            win.removeEventListener('pagehide', this._onUnload);
            doc.removeEventListener('xuexitong-helper-dispose', this._onUnload);
            this._panel?.remove();
            this._panel = null;
        },

        // 每次重新获取目录，兼容页面局部重绘，不再缓存过期 jQuery 对象。
        _nodes() {
            return Array.from(doc.querySelectorAll('#coursetree .posCatalog_select:not(.firstLayer)'));
        },

        // 只有唯一激活的小节才能作为自动导航起点，避免默认跳到第一章。
        _currentNode() {
            const active = this._nodes().filter(node => node.classList.contains('posCatalog_active'));
            return active.length === 1 ? active[0] : null;
        },

        // 小节身份优先使用平台稳定编号，不能使用可能因重绘而变化的 DOM 对象。
        _nodeKey(node) {
            if (!node) return null;
            const id = node.id.trim();
            const chapter = id.match(/^cur(\d+)$/);
            if (chapter) return 'chapter:' + chapter[1];
            if (id) return 'id:' + id;
            const index = this._nodes().indexOf(node);
            const name = node.querySelector('.posCatalog_name');
            return index < 0 ? null : 'position:' + index + ':' + text(name?.getAttribute('title') || name?.textContent);
        },

        // 若已加载的课程地址提供了小节编号，必须与当前目录目标一致。
        _loadedUnitMatches(snapshot, key) {
            if (!key?.startsWith('chapter:')) return true;
            return snapshot.courseFrames.every(frame => !frame.context?.chapter ||
                key === 'chapter:' + frame.context.chapter);
        },

        // 整节完成必须有本节点的明确图标，空计数/零计数或子节点图标都不能代替。
        _unitComplete(node) {
            if (!node) return false;
            // 限定标记所属目录节点，排除嵌套小节中的完成标记。
            const owned = selector => Array.from(node.querySelectorAll(selector)).filter(element =>
                element.closest('.posCatalog_select') === node);
            const countPending = owned('.jobUnfinishCount').some(input =>
                /^\d+$/.test(input.value.trim()) && Number(input.value) > 0);
            const badgePending = owned('.catalog_points_yi').filter(visible).some(badge =>
                /[1-9]\d*\s*个待完成任务点/.test(badge.textContent) ||
                Array.from(badge.querySelectorAll('.orangeNew')).some(count => /^[1-9]\d*$/.test(count.textContent.trim())));
            return !countPending && !badgePending && owned('.icon_Completed').some(visible);
        },

        // 收集本页所有可见任务点，包括未识别成视频/文档的资源，防止漏项后跳走。
        _pageTaskStates(snapshot) {
            const wrappers = new Set();
            for (const current of snapshot.documents) {
                for (const marker of current.querySelectorAll('.ans-job-icon, .ans-attach-ct.ans-job-finished')) {
                    if (visible(marker)) wrappers.add(marker.closest('.ans-attach-ct') || marker);
                }
            }
            return Array.from(wrappers).map(taskPointState).filter(state => state !== null);
        },

        // 略过已确认完成的资源；正在看的视频仍等自然结束，除非整节已经完成。
        _skipConfirmedResources(tasks) {
            for (const task of tasks) {
                if (taskPointState(taskWrapper(task.element)) !== true) continue;
                if (this._completed.get(task.element) === fingerprint(task)) continue;
                if (this._active?.task.element === task.element) {
                    if (task.kind === 'video' && (!task.element.ended || task.element.seeking)) continue;
                    this._completeTask(this._active);
                } else {
                    this._completed.set(task.element, fingerprint(task));
                }
            }
        },

        // 获取已知步骤标签的 DOM 顺序，去掉嵌套标题和容器重复项。
        _steps() {
            const candidates = Array.from(doc.querySelectorAll('.prev_white, .prev_title'));
            return candidates.filter(el => visible(el) && !candidates.some(other => other !== el && other.contains(el)));
        },

        // 读取当前步骤名称，仅用于识别视频、课件和需要手动处理的测验。
        _currentStepTitle() {
            const el = doc.querySelector('.prev_title');
            return text(el?.getAttribute('title') || el?.textContent);
        },

        // 优先用课程卡片编号识别步骤；章节标题或提示文字的更新不算切换。
        _currentStepKey(snapshot = scanResources()) {
            const context = snapshot.courseFrames.find(frame => frame.context?.card !== null && frame.context?.card !== undefined)?.context;
            if (context) return 'card:' + context.card;
            const el = doc.querySelector('.prev_title');
            if (!el) return '';
            const directText = Array.from(el.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent).join('').replace(/\s+/g, '');
            const label = text(el.getAttribute('title') || directText);
            if (!/^(学习目标|学习导引|导学|视频|文档|课件|章节测验|考试|作业|测试)$/.test(label)) return '';
            const index = this._steps().findIndex(step => step === el || step.contains(el));
            return index + ':' + label + ':' + directText;
        },

        // 原生切换前记录旧资源，必须看到内容替换后才接管新页面。
        _navigate(target, kind, snapshot) {
            if (this._transition || !visible(target)) return;
            const targetKey = this._nodeKey(kind === 'unit' ? target : this._currentNode());
            if (kind === 'unit' && (!targetKey || this._nodes().filter(node => this._nodeKey(node) === targetKey).length !== 1)) {
                return this.stop('目标小节编号不唯一，请手动检查目录。');
            }
            this._releaseActive();
            this._generation++;
            this._transition = {
                targetKey, kind, since: now(),
                ...navigationSnapshot(snapshot),
                oldStepKey: this._currentStepKey(snapshot),
            };
            this._status('等待页面切换');
            (kind === 'unit' ? target.querySelector('.posCatalog_name') : target)?.click();
        },

        // 等待目录/步骤和资源一起发生变化，防止点击后再次操作旧视频。
        _awaitNavigation(snapshot) {
            const pending = this._transition;
            if (!pending) return false;
            if (now() - pending.since > this.configs.resourceTimeoutMs) {
                this.stop('页面切换未确认，请手动选择小节后点击开始。');
                return true;
            }
            const currentKey = this._nodeKey(this._currentNode());
            const selected = currentKey === pending.targetKey && (pending.kind === 'unit' ||
                this._currentStepKey(snapshot) !== pending.oldStepKey);
            // 局部路由可能复用同一个 document；已加载的编号变化也是换页证据。
            const frameChanged = snapshot.courseFrames.some(frame => {
                if (!frame.document) return false;
                const old = pending.courseFrames.find(item => item.element === frame.element && item.document === frame.document);
                if (!old) return true;
                const before = old.context;
                const after = frame.context;
                return Boolean(before?.chapter && after?.chapter && (before.chapter !== after.chapter ||
                    (before.card !== null && after.card !== null && before.card !== after.card)));
            });
            const oldResourceRemains = snapshot.tasks.some(task => pending.tasks.some(old =>
                old.element === task.element && old.source === fingerprint(task) && old.document === resourceDocument(task) &&
                !(old.kind === 'video' && old.ended && !task.element.ended && !task.element.seeking)));
            const hadLoadedResource = pending.tasks.some(task => task.kind !== 'pending');
            const newResourceDocument = snapshot.tasks.some(task => {
                const current = resourceDocument(task);
                return current && !pending.documents.includes(current);
            });
            const newContent = !oldResourceRemains && (pending.courseFrames.length > 0 ? frameChanged :
                (hadLoadedResource || newResourceDocument));
            if (!selected || !newContent || !this._loadedUnitMatches(snapshot, pending.targetKey) || now() - pending.since < 1500) return true;
            this._transition = null;
            this._waitingSince = now();
            this._emptySince = null;
            return false;
        },

        // 找到后续第一个未完成小节，一次原生点击，避免连续加载已经完成的中间小节。
        nextUnit() {
            if (this._transition) return;
            const nodes = this._nodes();
            const index = nodes.indexOf(this._currentNode());
            if (index < 0) return this.stop('无法确定当前小节，请先手动选择一个小节。');
            let next = index + 1;
            while (next < nodes.length && this._unitComplete(nodes[next])) next++;
            if (next >= nodes.length) return this.stop('后续小节均已完成或已到目录末尾，请在平台核对完成记录。');
            if (!nodes[next].querySelector('.posCatalog_name')) return this.stop('下一小节没有可识别的按钮。');
            if (!this._running) this.run();
            if (this._running) this._navigate(nodes[next], 'unit', scanResources());
        },

        // 当前页全部资源结束后才推进步骤；不自动点击或回答测验。
        _advance(snapshot) {
            const steps = this._steps();
            const title = doc.querySelector('.prev_title');
            const index = steps.findIndex(el => el === title || el.contains(title));
            if (index >= 0 && index + 1 < steps.length) {
                const next = steps[index + 1];
                if (/测验|考试|作业|测试/.test(text(next.textContent))) {
                    return this.stop('下一步骤是测验或作业，请手动完成。');
                }
                this._navigate(next, 'step', snapshot);
                return;
            }
            this.nextUnit();
        },

        // 统一驱动扫描、视频、文档和导航；所有等待都有可见状态和时限。
        tick() {
            if (!this._running) return;
            try {
                this._mountPanel();
                const snapshot = scanResources();
                const blocked = blocker(snapshot.documents);
                if (blocked) return this.stop(blocked);
                const wasTransitioning = Boolean(this._transition);
                if (this._awaitNavigation(snapshot)) return;
                const unit = this._currentNode();
                const unitKey = this._nodeKey(unit);
                const step = this._currentStepTitle();
                const stepKey = this._currentStepKey(snapshot);
                // 真正的小节/卡片改变才等待同步；同一编号的目录重绘不暂停视频。
                const contextChanged = unitKey !== this._unitKey || stepKey !== this._stepKey;
                const wrongContent = unitKey && !this._loadedUnitMatches(snapshot, unitKey);
                if (wrongContent || (!wasTransitioning && this._unitKey && unitKey && this._lastSnapshot && contextChanged)) {
                    this._releaseActive();
                    this._generation++;
                    this._transition = {
                        ...(this._lastSnapshot || navigationSnapshot(snapshot)), targetKey: unitKey,
                        kind: wrongContent || unitKey !== this._unitKey ? 'unit' : 'step',
                        since: now(), oldStepKey: this._stepKey,
                    };
                    this._status('课程位置已变化，等待目录与内容同步');
                    return;
                }
                if (contextChanged) {
                    this._releaseActive();
                    this._generation++;
                    this._completed.clear();
                    this._unitKey = unitKey;
                    this._step = step;
                    this._stepKey = stepKey;
                    this._waitingSince = now();
                    this._emptySince = null;
                }
                this._unit = unit;
                this._lastSnapshot = navigationSnapshot(snapshot);
                const pointStates = this._pageTaskStates(snapshot);
                if (this._unitComplete(unit) && !pointStates.includes(false)) {
                    if (!this.configs.autoplay) return this.stop('本小节任务点已完成，自动切换已关闭。');
                    this._status('平台已确认本小节完成，正在进入下一小节');
                    this.nextUnit();
                    return;
                }
                if (/测验|考试|作业|测试/.test(step)) return this.stop('当前为测验或作业，请手动完成后点击开始。');
                this._skipConfirmedResources(snapshot.tasks);
                const task = snapshot.tasks.find(item => this._completed.get(item.element) !== fingerprint(item));
                if (task) {
                    this._emptySince = null;
                    if (this._active && (this._active.task.element !== task.element || this._active.source !== fingerprint(task))) {
                        this._releaseActive();
                        this._generation++;
                        this._waitingSince = now();
                    }
                    if (task.kind === 'pending') {
                        if (now() - this._waitingSince > this.configs.resourceTimeoutMs) {
                            return this.stop('课程框架未加载或跨域不可访问，请手动打开资源检查。');
                        }
                        return this._status('等待课程框架或下一个视频加载');
                    }
                    if (task.kind === 'video') this._videoTick(task);
                    else this._documentTick(task);
                    return;
                }
                if (!doc.querySelector('#coursetree')) {
                    if (now() - this._startedAt > this.configs.startupTimeoutMs) return this.stop('未找到课程目录，请在课程播放页运行并刷新。');
                    return this._status('脚本已运行，等待课程目录加载');
                }
                if (this._emptySince === null) this._emptySince = now();
                if (!snapshot.tasks.length) {
                    if (/^(学习目标|导学|学习导引)$/.test(step) && now() - this._emptySince >= this.configs.settleMs) {
                        return this._advance(snapshot);
                    }
                    if (now() - this._waitingSince > this.configs.resourceTimeoutMs) return this.stop('未识别到视频或文档，已停止，请检查当前资源。');
                    return this._status('等待视频或文档资源出现');
                }
                const incomplete = pointStates.includes(false) ||
                    snapshot.tasks.some(item => taskPointState(taskWrapper(item.element)) === false);
                if (incomplete) {
                    if (now() - this._emptySince > this.configs.resourceTimeoutMs) return this.stop('平台任务点尚未显示完成，请检查后再继续。');
                    return this._status('资源已浏览，等待平台任务点确认');
                }
                const allConfirmed = snapshot.tasks.every(item => taskPointState(taskWrapper(item.element)) === true);
                if (!allConfirmed && now() - this._emptySince < this.configs.settleMs) return this._status('未找到完整保存标记，保留短暂等待');
                if (!this.configs.autoplay) return this.stop('本页资源结束，自动切换已关闭。');
                this._advance(snapshot);
            } catch (error) {
                this.stop('页面处理失败（' + (error?.name || 'Error') + '），请检查后点击开始。');
            }
        },

        // 建立当前视频状态，每个媒体元素只绑定一组可解除的事件。
        _startVideo(task) {
            const video = task.element;
            const active = {
                task, source: fingerprint(task), since: now(), lastProgressAt: now(),
                lastTime: Number(video.currentTime || 0), endedAt: null,
                oldMuted: video.muted, oldRate: video.playbackRate,
                owner: this._owner + ':' + this._generation,
                pending: false, attempts: 0, nextAttemptAt: now(), started: false,
            };
            // 自然结束仅进入保存等待，不直接跳过同一小节剩余资源。
            active.onEnded = () => {
                if (this._active === active && video.ended && !video.seeking && active.endedAt === null) active.endedAt = now();
            };
            // 媒体错误停止当前队列，避免误把加载失败当作已完成。
            active.onError = () => { if (this._active === active) this.stop('视频加载错误，请手动检查播放器。'); };
            this._active = active;
            video.setAttribute('data-xuexitong-helper-owner', active.owner);
            video.addEventListener('ended', active.onEnded);
            video.addEventListener('error', active.onError);
            const rate = Number(this.configs.playbackRate);
            video.playbackRate = Number.isFinite(rate) && rate >= 0.5 && rate <= 2 ? rate : 1;
            if (this.configs.muted) video.muted = true;
            if (video.ended && !video.seeking) active.endedAt = now();
            else this._attemptPlayback(active);
        },

        // 使用原生 play()；只在自动播放许可被拒绝时尝试一次静音启动。
        _attemptPlayback(active) {
            const video = active.task.element;
            const generation = this._generation;
            active.pending = true;
            active.requestAt = now();
            active.attempts++;
            this._status('正在启动当前视频');
            let result;
            try { result = video.play(); } catch (error) { result = Promise.reject(error); }
            Promise.resolve(result).then(() => {
                if (!this._running || this._generation !== generation || this._active !== active) {
                    const owner = video.getAttribute('data-xuexitong-helper-owner');
                    if (!owner || owner === active.owner) video.pause();
                    return;
                }
                active.pending = false;
                active.started = true;
                active.lastProgressAt = now();
                this._status('视频播放中');
            }).catch(error => {
                if (!this._running || this._generation !== generation || this._active !== active) return;
                active.pending = false;
                if (error.name === 'NotAllowedError' && this.configs.mutedFallback && !video.muted) {
                    this.setMuted(true);
                    active.nextAttemptAt = now();
                    this._status('自动播放被限制，准备静音重试');
                } else if (error.name === 'AbortError' && active.attempts < this.configs.maxRetries) {
                    active.nextAttemptAt = now() + this.configs.retryInterval;
                    this._status('播放器初始化中，等待重试');
                } else {
                    this.stop('播放未获许可或发生错误，请手动播放一次，再点击开始。');
                }
            });
        },

        // 视频结束后每轮读取平台保存标记，确认即继续；没有标记才使用保守等待。
        _videoTick(task) {
            if (!this._active) this._startVideo(task);
            const active = this._active;
            if (!active || !this._running) return;
            const video = task.element;
            if (video.error) return this.stop('视频加载错误，请手动检查播放器。');
            if (video.ended && !video.seeking) {
                if (active.endedAt === null) active.endedAt = now();
                const saved = taskPointState(taskWrapper(video));
                if (saved === true || (saved === null && now() - active.endedAt >= this.configs.settleMs)) {
                    this._completeTask(active);
                } else if (saved === false && now() - active.endedAt > this.configs.resourceTimeoutMs) {
                    this.stop('平台任务点尚未显示完成，请检查后再继续。');
                } else {
                    this._status(saved === false ? '视频已结束，正在检查平台保存结果' : '视频已结束，未找到保存标记，保留短暂等待');
                }
                return;
            }
            active.endedAt = null;
            if (active.pending) {
                if (now() - active.requestAt > this.configs.playTimeoutMs) this.stop('视频启动超时，请手动检查播放器。');
                return;
            }
            if (!active.started) {
                if (now() >= active.nextAttemptAt) this._attemptPlayback(active);
                return;
            }
            if (video.paused) return this.stop('视频已暂停，请确认播放器状态后点击开始。');
            if (Math.abs(video.currentTime - active.lastTime) > 0.01) {
                active.lastTime = video.currentTime;
                active.lastProgressAt = now();
            } else if (now() - active.lastProgressAt > this.configs.stallTimeoutMs) {
                this.stop('视频长时间没有前进，请检查网络或播放器。');
            }
        },

        // 记录已浏览或已由平台确认的资源；保留结束时刻，避免再叠加整页等待。
        _completeTask(active) {
            this._completed.set(active.task.element, active.source);
            this._releaseActive();
            this._generation++;
            this._waitingSince = now();
            this._emptySince = active.endedAt ?? now();
            this._status('当前资源已结束，正在检查本节后续资源');
        },

        // 收集文档内部同源阅读器；跨域或浏览器内置 PDF 不尝试绕过。
        _documentViews(frame) {
            const views = [];
            const visited = new Set();
            let inaccessible = false;
            // 深度有界地读取子文档，用于寻找真正滚动的阅读区域。
            function visit(currentFrame, depth) {
                const current = frameDocument(currentFrame);
                if (!current || depth > 8) { inaccessible = true; return; }
                if (visited.has(current)) return;
                visited.add(current);
                views.push(current);
                for (const nested of current.querySelectorAll('iframe')) if (visible(nested)) visit(nested, depth + 1);
            }
            visit(frame, 0);
            return { views, inaccessible };
        },

        // 读取 PDF.js 的页码、总页数和原生下一页按钮，拒绝猜测无计数分页器。
        _pagination(views) {
            for (const current of views) {
                const page = current.querySelector('#pageNumber');
                const total = current.querySelector('#numPages');
                const next = current.querySelector('#next, #nextPage, [aria-label="下一页"], [title="下一页"]');
                if (!page || !total || !next || !visible(next)) continue;
                const number = Number(page.value || page.textContent);
                const label = total.textContent || '';
                const match = label.match(/(?:共|of|\/)\s*(\d+)/i) || label.match(/^\s*(\d+)\s*(?:页)?\s*$/);
                const count = Number(match?.[1]);
                if (Number.isInteger(number) && Number.isInteger(count) && number > 0 && count >= number) {
                    return { number, count, next };
                }
                return { invalid: true };
            }
            return null;
        },

        // 优先选择实际可滚动的阅读器，其次使用文档自身滚动区域。
        _scrollArea(views) {
            const areas = [];
            for (const current of views) {
                const body = current.body;
                if (!body || current.readyState === 'loading') continue;
                if (!body.querySelector('canvas, img, .page, article, p, table') && text(body.textContent).length < 20) continue;
                const root = current.scrollingElement || current.documentElement;
                const candidates = new Set([root, ...current.querySelectorAll('#viewerContainer, .pdfViewer, [role="document"], article')]);
                for (const element of candidates) {
                    if (!visible(element) || element.clientHeight <= 0 || element.scrollHeight <= 0) continue;
                    const overflow = current.defaultView.getComputedStyle(element).overflowY;
                    if (element !== root && !/auto|scroll/.test(overflow)) continue;
                    areas.push({ element, priority: element === root ? 0 : 1 });
                }
            }
            areas.sort((a, b) => b.priority - a.priority ||
                (b.element.scrollHeight - b.element.clientHeight) - (a.element.scrollHeight - a.element.clientHeight));
            return areas[0]?.element || null;
        },

        // 连续逐页或逐屏浏览，确认移动后继续；末尾单独等待，给懒加载留时间。
        _documentTick(task) {
            if (!this.configs.autoReadDocuments) return this.stop('文档自动浏览已关闭，请手动查看。');
            if (!this._active) {
                this._active = {
                    task, source: fingerprint(task), since: now(), lastAction: now(),
                    pagePending: null, scrollPending: null, bottomAt: null, height: null, actions: 0,
                };
            }
            const active = this._active;
            if (now() - active.since > this.configs.documentMaxMs || active.actions >= 1000) {
                return this.stop('文档浏览达到时限，请手动检查。');
            }
            const result = this._documentViews(task.element);
            if (result.inaccessible) return this.stop('文档跨域或无法访问，请手动打开阅读。');
            const blocked = blocker(result.views);
            if (blocked) return this.stop(blocked);
            if (result.views.some(current => current.querySelector('embed[type="application/pdf"], object[type="application/pdf"]'))) {
                return this.stop('当前是浏览器内置 PDF，请手动阅读；不自动跳过。');
            }
            const dwell = Math.max(100, Number(this.configs.documentDwellMs) || 250);
            const bottomDwell = Math.max(1000, Number(this.configs.documentBottomDwellMs) || 1000);
            const pages = this._pagination(result.views);
            if (pages?.invalid) {
                if (now() - active.since > this.configs.resourceTimeoutMs) return this.stop('文档页码格式无法确认，请手动查看。');
                return this._status('等待可靠的文档页码');
            }
            if (pages) {
                if (active.pagePending) {
                    if (pages.number === active.pagePending.expected) {
                        active.pagePending = null;
                    } else if (now() - active.pagePending.since > this.configs.resourceTimeoutMs) {
                        return this.stop('点击后文档页码没有按预期变化，请手动检查。');
                    } else return this._status('等待文档翻页完成');
                }
                this._status('文档浏览中：第 ' + pages.number + '/' + pages.count + ' 页');
                const pageKey = pages.number + '/' + pages.count;
                if (active.lastPage !== pageKey) active.bottomAt = null;
                active.lastPage = pageKey;
                if (pages.number === pages.count) {
                    if (active.bottomAt === null) active.bottomAt = now();
                    if (now() - active.bottomAt >= bottomDwell && now() - active.lastAction >= dwell) this._completeTask(active);
                    return;
                }
                active.bottomAt = null;
                if (now() - active.lastAction < dwell) return;
                if (pages.next.disabled || pages.next.getAttribute('aria-disabled') === 'true') {
                    return this.stop('文档下一页暂不可用，请手动检查。');
                }
                active.pagePending = { expected: pages.number + 1, since: now() };
                active.lastAction = now();
                active.actions++;
                pages.next.click();
                return;
            }
            const area = this._scrollArea(result.views);
            if (!area) {
                if (now() - active.since > this.configs.resourceTimeoutMs) return this.stop('未识别到可滚动文档或有页码的阅读器，请手动查看。');
                return this._status('等待文档阅读器加载');
            }
            if (active.scrollPending) {
                if (area === active.scrollPending.area && area.scrollTop > active.scrollPending.top + 1) {
                    active.scrollPending = null;
                } else if (now() - active.scrollPending.since > this.configs.resourceTimeoutMs) {
                    return this.stop('文档滚动没有生效，请手动查看。');
                } else return this._status('等待文档滚动完成');
            }
            const bottom = area.scrollTop + area.clientHeight >= area.scrollHeight - 2;
            if (active.height !== area.scrollHeight || !bottom) active.bottomAt = null;
            active.height = area.scrollHeight;
            this._status('文档逐屏浏览中');
            if (bottom) {
                if (active.bottomAt === null) active.bottomAt = now();
                if (now() - active.bottomAt >= bottomDwell && now() - active.lastAction >= dwell) this._completeTask(active);
                return;
            }
            if (now() - active.lastAction < dwell) return;
            active.scrollPending = { area, top: area.scrollTop, since: now() };
            active.lastAction = now();
            active.actions++;
            area.scrollTop = Math.min(area.scrollHeight - area.clientHeight, area.scrollTop + Math.max(1, area.clientHeight));
        },
    };
    Object.assign(app.configs, options.configs || {});
    app._onStart = app.run.bind(app);
    app._onStop = app.stop.bind(app, '已手动停止');
    // 将复选框的用户选择传给静音控制函数，不读写浏览器存储。
    app._onMuteChange = event => app.setMuted(event.currentTarget.checked);
    // 收起按钮只改变显示，不通过开始/停止逻辑重新初始化任务。
    app._onCollapse = () => app.setCollapsed(!app._collapsed);
    app._onUnload = app.destroy.bind(app);
    win.addEventListener('pagehide', app._onUnload);
    doc.addEventListener('xuexitong-helper-dispose', app._onUnload);
    return app;
});

/*
 * Lucide chevron-up and chevron-down icon notices.
 * Source: https://github.com/lucide-icons/lucide
 *
 * ISC License
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * These two icons are derived from Feather and also carry this notice:
 * The MIT License (MIT)
 * Copyright (c) 2013-present Cole Bemis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
