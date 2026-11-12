// In-game feedback window (docs/feedback.md in metaverse-hub). One implementation for the hub and
// every game: press N twice, the game pauses, a small window takes a few option chips and an
// optional note, and the note is sent with a screenshot taken before the window appeared.
//
// Nothing here runs per frame except one timestamp subtraction for the FPS figure. Everything
// else (screenshot, context snapshot) happens once, when the window opens.
import { HubSdkError } from './errors';
import { captureBackdrop, capturePage, loadPageShot, pageBackground } from './pageShot';
export const FEEDBACK_CATEGORIES = [
    { id: 'broke', label: 'Something broke' },
    { id: 'unclear', label: 'Unclear what to do' },
    { id: 'too_hard', label: 'Too hard' },
    { id: 'too_easy', label: 'Too easy' },
    { id: 'controls', label: 'Controls feel off' },
    { id: 'performance', label: 'Performance issue' },
    { id: 'other', label: 'Other' },
];
/** Server limits (server/modules/src/games/hub_feedback.ts). */
export const FEEDBACK_NOTE_MAX = 2000;
export const FEEDBACK_IMAGE_MAX = 190_000;
export const FEEDBACK_META_MAX = 15_000;
const QUEUE_KEY = 'hub:feedback:queue';
const QUEUE_MAX = 4;
const BREADCRUMB_MAX = 24;
const ERROR_MAX = 10;
const DEFAULT_THEME = {
    font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    titleFont: 'inherit',
    background: 'rgba(5, 8, 16, 0.62)',
    panel: '#141a26',
    text: '#eef2f8',
    muted: '#9aa6b8',
    accent: '#4fd1e8',
    accentText: '#06131a',
    border: 'rgba(255, 255, 255, 0.16)',
    radius: '10px',
    css: '',
};
/** Feedback over a hub SDK instance. Standalone play and older SDK doubles answer `standalone`. */
export function feedbackTransportFromSdk(sdk) {
    return {
        async access() {
            if (!sdk.feedbackAccess)
                return { ok: false, reason: 'standalone' };
            return sdk.feedbackAccess();
        },
        async submit(input) {
            if (!sdk.submitFeedback)
                throw new HubSdkError('standalone', 'Feedback needs a hub session');
            return sdk.submitFeedback(input);
        },
    };
}
function clip(value, max) {
    const text = typeof value === 'string' ? value : value instanceof Error ? `${value.name}: ${value.message}` : String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
function describeError(value) {
    if (value && typeof value === 'object') {
        const e = value;
        const out = { message: clip(e.message ?? value, 300) };
        if (typeof e.stack === 'string')
            out.stack = clip(e.stack, 600);
        if (typeof e.at === 'number')
            out.at = e.at;
        else if (typeof e.time === 'number')
            out.at = e.time;
        return out;
    }
    return { message: clip(value, 300) };
}
/** Fit `meta` under the server cap by dropping the bulkiest optional parts first. */
export function fitFeedbackMeta(meta, max = FEEDBACK_META_MAX) {
    const out = { ...meta };
    const size = () => JSON.stringify(out).length;
    const trimList = (key, keep) => {
        const list = out[key];
        if (Array.isArray(list) && list.length > keep)
            out[key] = list.slice(list.length - keep);
    };
    if (size() > max)
        trimList('breadcrumbs', 8);
    if (size() > max)
        trimList('errors', 3);
    if (size() > max) {
        const errors = out.errors;
        if (Array.isArray(errors))
            out.errors = errors.map((e) => ({ message: clip(e.message ?? '', 160) }));
    }
    if (size() > max)
        delete out.extra;
    if (size() > max)
        delete out.breadcrumbs;
    if (size() > max)
        delete out.player;
    if (size() > max)
        delete out.errors;
    return out;
}
/** True for failures worth retrying later (no network, server down), false for refusals. */
function retryable(error) {
    if (error instanceof HubSdkError)
        return error.code === 'rpc_failed' && (error.status === undefined || error.status >= 500);
    return error instanceof TypeError;
}
function css(theme) {
    return `
:host { all: initial; }
.root { position: fixed; inset: 0; z-index: 2147483000; font: 14px/1.4 ${theme.font}; color: ${theme.text}; pointer-events: none; }
.root * { box-sizing: border-box; }
.backdrop { position: absolute; inset: 0; background: ${theme.background}; display: flex; align-items: center; justify-content: center; padding: 12px; pointer-events: auto; }
.panel { width: min(460px, 100%); max-height: 100%; overflow: auto; background: ${theme.panel}; border: 1px solid ${theme.border}; border-radius: ${theme.radius}; padding: 14px 16px 12px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55); outline: none; }
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.title { font-family: ${theme.titleFont}; font-size: 16px; font-weight: 700; letter-spacing: 0.02em; }
.sub { color: ${theme.muted}; font-size: 11px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
button { font: inherit; color: inherit; cursor: pointer; }
.chip { background: transparent; border: 1px solid ${theme.border}; border-radius: ${theme.radius}; padding: 6px 9px; display: inline-flex; gap: 6px; align-items: center; }
.chip kbd { font: inherit; font-size: 10px; color: ${theme.muted}; }
.chip[aria-pressed="true"] { background: ${theme.accent}; border-color: ${theme.accent}; color: ${theme.accentText}; }
.chip[aria-pressed="true"] kbd { color: ${theme.accentText}; }
.chip:focus-visible, .btn:focus-visible, textarea:focus-visible { outline: 2px solid ${theme.accent}; outline-offset: 1px; }
textarea { width: 100%; min-height: 58px; resize: vertical; font: inherit; color: ${theme.text}; background: rgba(0, 0, 0, 0.28); border: 1px solid ${theme.border}; border-radius: ${theme.radius}; padding: 7px 9px; }
textarea::placeholder { color: ${theme.muted}; }
.shot { margin-top: 10px; position: relative; border: 1px solid ${theme.border}; border-radius: ${theme.radius}; overflow: hidden; background: #000; }
.shot canvas { display: block; max-width: 100%; max-height: 32vh; width: auto; height: auto; margin: 0 auto; touch-action: none; }
.shot.draw canvas { cursor: crosshair; }
.shotbar { display: flex; gap: 6px; align-items: center; justify-content: space-between; margin-top: 6px; color: ${theme.muted}; font-size: 11px; }
.shotbar .tools { display: flex; gap: 6px; }
.mini { background: transparent; border: 1px solid ${theme.border}; border-radius: ${theme.radius}; padding: 3px 8px; font-size: 11px; }
.mini[aria-pressed="true"] { border-color: ${theme.accent}; color: ${theme.accent}; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
.hint { color: ${theme.muted}; font-size: 11px; }
.actions { display: flex; gap: 8px; }
.btn { border: 1px solid ${theme.border}; background: transparent; border-radius: ${theme.radius}; padding: 7px 14px; }
.btn.primary { background: ${theme.accent}; border-color: ${theme.accent}; color: ${theme.accentText}; font-weight: 700; }
.btn[disabled] { opacity: 0.5; cursor: default; }
.msg { color: ${theme.muted}; margin: 4px 0 2px; min-height: 18px; font-size: 12px; }
.msg.bad { color: #ff9a8a; }
.toast { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); background: ${theme.panel}; border: 1px solid ${theme.border}; border-radius: ${theme.radius}; padding: 8px 12px; display: flex; gap: 10px; align-items: center; font-size: 12px; pointer-events: auto; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); max-width: calc(100% - 24px); }
.toast button { border: 1px solid ${theme.accent}; color: ${theme.accent}; background: transparent; border-radius: ${theme.radius}; padding: 3px 9px; font-size: 12px; }
@media (prefers-reduced-motion: no-preference) { .panel { animation: fb-in 90ms ease-out; } @keyframes fb-in { from { opacity: 0; transform: translateY(6px); } } }
${theme.css}`;
}
/**
 * Composite the page's canvases into one image no wider than `maxWidth`, and count the canvases
 * drawn. With `page`, the image covers the whole viewport and is returned even when no canvas
 * could be drawn, so an overlay can go on top.
 */
function captureCanvases(list, maxWidth, page = false) {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const visible = list
        .map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect() }))
        .filter(({ canvas, rect }) => canvas.width > 0 && canvas.height > 0 && rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.bottom > 0 && rect.left < vw && rect.top < vh);
    if (!visible.length && !page)
        return null;
    // One canvas: capture exactly its box. Several (minimap, effects): keep the page layout.
    let left = 0;
    let top = 0;
    let width = vw;
    let height = vh;
    if (visible.length === 1 && !page) {
        const r = visible[0].rect;
        left = r.left;
        top = r.top;
        width = r.width;
        height = r.height;
    }
    const scale = Math.min(1, maxWidth / width);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(width * scale));
    out.height = Math.max(1, Math.round(height * scale));
    const g = out.getContext('2d');
    if (!g)
        return null;
    // A page capture stays transparent: the page's background goes under it later.
    if (!page) {
        g.fillStyle = '#000';
        g.fillRect(0, 0, out.width, out.height);
    }
    let drawn = 0;
    for (const { canvas, rect } of visible) {
        try {
            g.imageSmoothingEnabled = getComputedStyle(canvas).imageRendering !== 'pixelated';
            g.drawImage(canvas, (rect.left - left) * scale, (rect.top - top) * scale, rect.width * scale, rect.height * scale);
            drawn += 1;
        }
        catch {
            // A tainted or lost canvas: skip it.
        }
    }
    return drawn || page ? { shot: out, drawn } : null;
}
/** Draw a whole-viewport layer onto a whole-viewport capture. */
function drawLayer(g, width, height, layer) {
    if (!layer || layer.width < 1 || layer.height < 1)
        return false;
    try {
        g.drawImage(layer, 0, 0, width, height);
        return true;
    }
    catch {
        return false;
    }
}
/** The page's background colour, its background picture, the canvases, then the HTML. */
function composePage(canvases, drawn, backdrop, overlay) {
    const out = document.createElement('canvas');
    out.width = canvases.width;
    out.height = canvases.height;
    const g = out.getContext('2d');
    if (!g)
        return drawn ? canvases : null;
    g.fillStyle = pageBackground();
    g.fillRect(0, 0, out.width, out.height);
    const under = drawLayer(g, out.width, out.height, backdrop);
    drawLayer(g, out.width, out.height, canvases);
    const over = drawLayer(g, out.width, out.height, overlay);
    // Without a canvas, a backdrop or an overlay the page capture is only a flat colour: send none.
    return drawn || under || over ? out : null;
}
const OVERLAY_WAIT_MS = 3000;
function encode(canvas, max) {
    let source = canvas;
    for (let attempt = 0; attempt < 4; attempt++) {
        for (const quality of [0.72, 0.55, 0.4]) {
            let url = '';
            try {
                url = source.toDataURL('image/jpeg', quality);
            }
            catch {
                return '';
            }
            if (url.length <= max && url.startsWith('data:image/jpeg'))
                return url;
        }
        const smaller = document.createElement('canvas');
        smaller.width = Math.max(1, Math.round(source.width * 0.7));
        smaller.height = Math.max(1, Math.round(source.height * 0.7));
        const g = smaller.getContext('2d');
        if (!g)
            return '';
        g.drawImage(source, 0, 0, smaller.width, smaller.height);
        source = smaller;
    }
    return '';
}
const NOOP = { open() { }, close() { }, isOpen: () => false, breadcrumb() { }, dispose() { } };
/**
 * Install the feedback shortcut and window. Call once at startup. Returns a no-op handle
 * outside a browser.
 */
export function installFeedback(options) {
    if (typeof window === 'undefined' || typeof document === 'undefined')
        return NOOP;
    const theme = { ...DEFAULT_THEME, ...(options.theme ?? {}) };
    const key = options.key ?? 'KeyN';
    const gap = options.doubleTapMs ?? 400;
    let storage = null;
    try {
        storage = options.storage === undefined ? window.localStorage : options.storage;
    }
    catch {
        storage = null;
    }
    const breadcrumbs = [];
    const errors = [];
    let access = null;
    let accessPending = null;
    let lastTap = -Infinity;
    let disposed = false;
    let host = null;
    let root = null;
    let panelOpen = false;
    /** A screenshot is being taken: a second shortcut must not start another. */
    let capturing = false;
    let closePanel = null;
    let panelKey = null;
    let toastTimer = 0;
    let lastCrashPrompt = -Infinity;
    // FPS: one subtraction per frame into a 120-slot ring.
    const frames = new Float32Array(120);
    let frameAt = 0;
    let frameCount = 0;
    let lastFrame = 0;
    let raf = 0;
    const tick = (now) => {
        if (lastFrame) {
            frames[frameAt] = now - lastFrame;
            frameAt = (frameAt + 1) % frames.length;
            if (frameCount < frames.length)
                frameCount += 1;
        }
        lastFrame = now;
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    function frameStats() {
        if (frameCount < 10)
            return null;
        let sum = 0;
        let worst = 0;
        for (let i = 0; i < frameCount; i++) {
            const dt = frames[i];
            sum += dt;
            if (dt > worst)
                worst = dt;
        }
        const mean = sum / frameCount;
        return { fps: Math.round(1000 / mean), frameMs: Math.round(mean * 10) / 10, worstFrameMs: Math.round(worst) };
    }
    function checkAccess(force = false) {
        if (access && !force)
            return Promise.resolve(access);
        if (accessPending)
            return accessPending;
        accessPending = options.transport
            .access()
            .catch((error) => ({ ok: false, reason: error instanceof HubSdkError ? error.code : 'offline' }))
            .then((result) => {
            accessPending = null;
            // "offline" is not remembered: the next press asks again.
            access = result.ok || result.reason !== 'offline' ? result : null;
            if (result.ok)
                void flushQueue();
            return result;
        });
        return accessPending;
    }
    // ---------------------------------------------------------------- queue
    function readQueue() {
        if (!storage)
            return [];
        try {
            const raw = storage.getItem(QUEUE_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        }
        catch {
            return [];
        }
    }
    function writeQueue(list) {
        if (!storage)
            return;
        try {
            if (list.length)
                storage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-QUEUE_MAX)));
            else
                storage.removeItem(QUEUE_KEY);
        }
        catch {
            // Quota: retry without the screenshots.
            try {
                storage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-QUEUE_MAX).map((item) => ({ ...item, image: '' }))));
            }
            catch {
                // Give up on the queue.
            }
        }
    }
    let flushing = false;
    async function flushQueue() {
        if (flushing)
            return;
        flushing = true;
        try {
            let list = readQueue();
            while (list.length) {
                const next = list[0];
                try {
                    await options.transport.submit(next);
                }
                catch (error) {
                    if (retryable(error))
                        return;
                }
                list = readQueue().slice(1);
                writeQueue(list);
            }
        }
        finally {
            flushing = false;
        }
    }
    // ---------------------------------------------------------------- DOM
    function mount() {
        const parent = document.fullscreenElement ?? document.body;
        if (host && root && host.parentNode === parent)
            return root;
        if (host)
            host.remove();
        host = document.createElement('div');
        host.setAttribute('data-hub-feedback', '');
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = css(theme);
        root = document.createElement('div');
        root.className = 'root';
        shadow.append(style, root);
        parent.append(host);
        return root;
    }
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className)
            node.className = className;
        if (text !== undefined)
            node.textContent = text;
        return node;
    }
    function toast(message, action, ms = 3200) {
        const parent = mount();
        parent.querySelector('.toast')?.remove();
        window.clearTimeout(toastTimer);
        const node = el('div', 'toast');
        node.setAttribute('role', 'status');
        node.append(el('span', undefined, message));
        if (action) {
            const button = el('button', undefined, action.label);
            button.type = 'button';
            button.addEventListener('click', () => {
                node.remove();
                action.run();
            });
            node.append(button);
        }
        parent.append(node);
        toastTimer = window.setTimeout(() => node.remove(), ms);
    }
    function refusal(reason) {
        if (reason === 'standalone')
            return 'Feedback works when you play from the hub while signed in.';
        if (reason === 'sign_in_required')
            return 'Sign in to a hub account to send feedback.';
        if (reason === 'offline')
            return 'Cannot reach the hub right now. Try again in a moment.';
        return 'Feedback is not available right now.';
    }
    function snapshot(source) {
        const now = new Date();
        let context = {};
        try {
            context = options.context?.() ?? {};
        }
        catch (error) {
            context = { extra: { contextError: clip(error, 200) } };
        }
        const own = (() => {
            try {
                return (options.errors?.() ?? []).slice(-ERROR_MAX).map(describeError);
            }
            catch {
                return [];
            }
        })();
        const seen = new Set();
        const allErrors = [...own, ...errors].filter((e) => {
            const k = String(e.message);
            if (seen.has(k))
                return false;
            seen.add(k);
            return true;
        });
        const nav = navigator;
        const memory = performance.memory;
        let pads = 0;
        try {
            pads = (nav.getGamepads?.() ?? []).filter(Boolean).length;
        }
        catch {
            pads = 0;
        }
        const meta = {
            title: options.title,
            version: options.version ?? '',
            level: context.level ?? '',
            mode: context.mode ?? '',
            position: context.position ?? null,
            gameTime: typeof context.gameTime === 'number' && Number.isFinite(context.gameTime) ? Math.round(context.gameTime * 100) / 100 : null,
            player: context.player ?? null,
            extra: context.extra ?? null,
            source,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
            utcOffsetMinutes: -now.getTimezoneOffset(),
            sessionSeconds: Math.round(performance.now() / 1000),
            perf: frameStats(),
            heapMb: memory ? Math.round(memory.usedJSHeapSize / 1048576) : null,
            page: location.pathname,
            viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
            userAgent: clip(nav.userAgent, 220),
            language: nav.language,
            input: { gamepads: pads, touch: nav.maxTouchPoints > 0 },
            fullscreen: !!document.fullscreenElement,
            errors: allErrors.slice(-ERROR_MAX),
            breadcrumbs: breadcrumbs.slice(),
        };
        return { meta: fitFeedbackMeta(meta), clientTime: now.toISOString() };
    }
    function send(submission) {
        options.transport.submit(submission).then((result) => toast(`Feedback sent · ${result.id}`), (error) => {
            if (retryable(error)) {
                writeQueue([...readQueue(), submission]);
                toast('Feedback saved. It will send when the hub is reachable.');
            }
            else {
                const code = error instanceof HubSdkError ? error.code : '';
                if (code === 'sign_in_required' || code === 'standalone')
                    access = { ok: false, reason: code };
                toast(code === 'rate_limited' ? 'Too many notes in a short time. Try again in a few minutes.' : refusal(code));
            }
        });
    }
    function openPanel(source, shot, captured) {
        if (panelOpen || disposed)
            return;
        panelOpen = true;
        const previousFocus = document.activeElement;
        let token;
        try {
            if (document.pointerLockElement)
                document.exitPointerLock();
            token = options.pause ? options.pause() : false;
        }
        catch {
            token = false;
        }
        const running = token === false;
        captured.meta.paused = !running;
        const parent = mount();
        parent.querySelector('.toast')?.remove();
        const backdrop = el('div', 'backdrop');
        const panel = el('div', 'panel');
        panel.tabIndex = -1;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', `Feedback for ${options.title}`);
        const head = el('div', 'head');
        head.append(el('div', 'title', source === 'crash' ? 'Report a problem' : 'Feedback'), el('div', 'sub', running ? `${options.title} · game keeps running` : `${options.title} · paused`));
        panel.append(head);
        const selected = new Set();
        if (source === 'crash')
            selected.add('broke');
        const chips = el('div', 'chips');
        const chipButtons = [];
        FEEDBACK_CATEGORIES.forEach((category, index) => {
            const chip = el('button', 'chip');
            chip.type = 'button';
            chip.setAttribute('aria-pressed', String(selected.has(category.id)));
            chip.append(el('kbd', undefined, String(index + 1)), el('span', undefined, category.label));
            chip.addEventListener('click', () => toggle(index));
            chipButtons.push(chip);
            chips.append(chip);
        });
        panel.append(chips);
        function toggle(index) {
            const category = FEEDBACK_CATEGORIES[index];
            const chip = chipButtons[index];
            if (!category || !chip)
                return;
            if (selected.has(category.id))
                selected.delete(category.id);
            else
                selected.add(category.id);
            chip.setAttribute('aria-pressed', String(selected.has(category.id)));
            message.textContent = '';
        }
        const note = el('textarea');
        note.maxLength = FEEDBACK_NOTE_MAX;
        note.placeholder = 'Optional note (Tab to type)';
        note.setAttribute('aria-label', 'Note');
        panel.append(note);
        // Screenshot preview. Drawing on it is optional: strokes are merged in on send.
        const strokes = [];
        let drawing = false;
        let drawMode = false;
        let preview = null;
        const repaint = () => {
            if (!preview || !shot)
                return;
            const g = preview.getContext('2d');
            if (!g)
                return;
            g.drawImage(shot, 0, 0);
            g.lineWidth = Math.max(3, preview.width / 220);
            g.lineCap = 'round';
            g.lineJoin = 'round';
            g.strokeStyle = '#ff3b30';
            for (const stroke of strokes) {
                g.beginPath();
                for (let i = 0; i < stroke.points.length; i += 2) {
                    if (i === 0)
                        g.moveTo(stroke.points[i], stroke.points[i + 1]);
                    else
                        g.lineTo(stroke.points[i], stroke.points[i + 1]);
                }
                if (stroke.points.length === 2)
                    g.lineTo(stroke.points[0] + 0.1, stroke.points[1]);
                g.stroke();
            }
        };
        if (shot) {
            const wrap = el('div', 'shot');
            preview = el('canvas');
            preview.width = shot.width;
            preview.height = shot.height;
            wrap.append(preview);
            const point = (event) => {
                const r = preview.getBoundingClientRect();
                return [((event.clientX - r.left) / r.width) * preview.width, ((event.clientY - r.top) / r.height) * preview.height];
            };
            preview.addEventListener('pointerdown', (event) => {
                if (!drawMode)
                    return;
                drawing = true;
                preview.setPointerCapture(event.pointerId);
                strokes.push({ points: point(event) });
                repaint();
            });
            preview.addEventListener('pointermove', (event) => {
                if (!drawing)
                    return;
                strokes[strokes.length - 1].points.push(...point(event));
                repaint();
            });
            const stop = () => {
                drawing = false;
            };
            preview.addEventListener('pointerup', stop);
            preview.addEventListener('pointercancel', stop);
            const bar = el('div', 'shotbar');
            const tools = el('div', 'tools');
            const draw = el('button', 'mini', 'Draw on it');
            draw.type = 'button';
            draw.setAttribute('aria-pressed', 'false');
            draw.addEventListener('click', () => {
                drawMode = !drawMode;
                draw.setAttribute('aria-pressed', String(drawMode));
                wrap.classList.toggle('draw', drawMode);
            });
            const undo = el('button', 'mini', 'Undo');
            undo.type = 'button';
            undo.addEventListener('click', () => {
                strokes.pop();
                repaint();
            });
            tools.append(draw, undo);
            bar.append(el('span', undefined, 'Screenshot from just before this window'), tools);
            panel.append(wrap, bar);
            repaint();
        }
        const message = el('div', 'msg');
        message.setAttribute('aria-live', 'polite');
        panel.append(message);
        const foot = el('div', 'foot');
        const actions = el('div', 'actions');
        const cancel = el('button', 'btn', 'Close');
        cancel.type = 'button';
        const submit = el('button', 'btn primary', 'Send');
        submit.type = 'button';
        actions.append(cancel, submit);
        foot.append(el('div', 'hint', '1–7 pick · Enter send · Esc close'), actions);
        panel.append(foot);
        backdrop.append(panel);
        parent.append(backdrop);
        panel.focus({ preventScroll: true });
        let allowed = access?.ok === true;
        if (!allowed) {
            submit.disabled = true;
            message.textContent = 'Checking your hub sign-in…';
            void checkAccess(true).then((result) => {
                if (!panelOpen)
                    return;
                allowed = result.ok;
                submit.disabled = !result.ok;
                message.textContent = result.ok ? '' : refusal(result.reason);
                message.classList.toggle('bad', !result.ok);
            });
        }
        const close = () => {
            if (!panelOpen)
                return;
            panelOpen = false;
            closePanel = null;
            panelKey = null;
            backdrop.remove();
            lastFrame = 0;
            try {
                previousFocus?.focus?.({ preventScroll: true });
            }
            catch {
                // The element went away.
            }
            try {
                if (!running)
                    options.resume?.(token);
            }
            finally {
                options.onClose?.();
            }
        };
        closePanel = close;
        const doSubmit = () => {
            if (!allowed || submit.disabled)
                return;
            const text = note.value.trim();
            if (!selected.size && !text) {
                message.textContent = 'Pick an option or write a note.';
                message.classList.add('bad');
                return;
            }
            const image = preview ? encode(preview, FEEDBACK_IMAGE_MAX) : '';
            if (strokes.length)
                captured.meta.annotated = true;
            const submission = {
                categories: FEEDBACK_CATEGORIES.map((c) => c.id).filter((id) => selected.has(id)),
                note: text.slice(0, FEEDBACK_NOTE_MAX),
                image,
                clientTime: captured.clientTime,
                source,
                meta: captured.meta,
            };
            close();
            send(submission);
        };
        cancel.addEventListener('click', close);
        submit.addEventListener('click', doSubmit);
        backdrop.addEventListener('pointerdown', (event) => {
            if (event.target === backdrop)
                close();
        });
        panelKey = (event) => {
            const typing = event.composedPath()[0] === note;
            if (event.type !== 'keydown')
                return;
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
            }
            else if (event.key === 'Enter' && (!typing || event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                doSubmit();
            }
            else if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && /^[1-7]$/.test(event.key)) {
                event.preventDefault();
                toggle(Number(event.key) - 1);
            }
            else if (event.key === 'Tab') {
                // Keep focus inside the window.
                const focusable = [...chipButtons, note, ...Array.from(panel.querySelectorAll('.mini, .btn'))].filter((n) => !n.disabled);
                const current = focusable.indexOf(event.composedPath()[0]);
                const next = current < 0 ? (event.shiftKey ? focusable.length - 1 : chipButtons.length) : (current + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
                event.preventDefault();
                focusable[next]?.focus();
            }
        };
        options.onOpen?.();
    }
    function begin(source) {
        if (panelOpen || capturing || disposed)
            return;
        if (access && !access.ok) {
            toast(refusal(access.reason));
            // Standalone never changes; a sign-in might have happened since.
            if (access.reason !== 'standalone')
                void checkAccess(true);
            return;
        }
        // Snapshot and screenshot first, in the next frame: a later-registered frame callback runs
        // after the game's own, so a WebGL canvas still holds the frame it just drew.
        capturing = true;
        const captured = snapshot(source);
        let done = false;
        const run = () => {
            if (done)
                return;
            done = true;
            const page = options.overlay !== false;
            let capture = null;
            let list = [];
            try {
                options.beforeCapture?.();
                list = options.canvases?.() ?? Array.from(document.querySelectorAll('canvas'));
                // Copy the canvases now: a WebGL frame is only readable in this task.
                capture = captureCanvases(list, 960, page);
            }
            catch {
                capture = null;
            }
            if (!page || !capture) {
                capturing = false;
                openPanel(source, capture?.shot ?? null, captured);
                return;
            }
            const { shot, drawn } = capture;
            // Read one pixel now: the copy finishes the GPU work behind it here, in the screenshot's
            // frame, instead of inside the HTML drawing below and against its time limit (that work took
            // seconds in a software renderer).
            try {
                shot.getContext('2d')?.getImageData(0, 0, 1, 1);
            }
            catch {
                // Nothing to wait for.
            }
            let finished = false;
            const finish = (layers) => {
                if (finished)
                    return;
                finished = true;
                capturing = false;
                openPanel(source, composePage(shot, drawn, layers[0], layers[1]), captured);
            };
            const timer = window.setTimeout(() => finish([null, null]), OVERLAY_WAIT_MS);
            const own = typeof options.overlay === 'function' ? options.overlay : null;
            const drawHtml = own ?? (() => capturePage(document.body, [...list, ...(host ? [host] : [])], 960, OVERLAY_WAIT_MS));
            const drawBackdrop = own ? () => null : () => captureBackdrop(document.body, 960, OVERLAY_WAIT_MS);
            Promise.all([
                Promise.resolve()
                    .then(() => drawBackdrop())
                    .catch(() => null),
                Promise.resolve()
                    .then(() => drawHtml())
                    .catch(() => null),
            ]).then((layers) => {
                window.clearTimeout(timer);
                finish([layers[0] ?? null, layers[1] ?? null]);
            });
        };
        requestAnimationFrame(run);
        // A hidden tab never gets a frame: open anyway.
        window.setTimeout(run, 250);
    }
    // ---------------------------------------------------------------- input
    function editable(target) {
        const node = target;
        if (!node || typeof node.tagName !== 'string')
            return false;
        if (node.isContentEditable)
            return true;
        if (node.tagName === 'TEXTAREA' || node.tagName === 'SELECT')
            return true;
        if (node.tagName !== 'INPUT')
            return false;
        const type = node.type;
        return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(type);
    }
    const onKey = (event) => {
        if (panelOpen) {
            // The game must not see typing meant for the window.
            event.stopImmediatePropagation();
            panelKey?.(event);
            return;
        }
        if (event.code !== key || event.ctrlKey || event.metaKey || event.altKey)
            return;
        if (editable(event.composedPath()[0] ?? event.target))
            return;
        try {
            if (options.enabled && !options.enabled())
                return;
        }
        catch {
            return;
        }
        // The shortcut key belongs to feedback: the game never sees it.
        event.stopImmediatePropagation();
        event.preventDefault();
        if (event.type !== 'keydown' || event.repeat)
            return;
        const now = performance.now();
        if (now - lastTap <= gap) {
            lastTap = -Infinity;
            begin('manual');
        }
        else {
            lastTap = now;
        }
    };
    const onError = (event) => {
        const reason = 'reason' in event ? event.reason : (event.error ?? event.message);
        const entry = describeError(reason);
        entry.at = Math.round(performance.now());
        if ('filename' in event && event.filename)
            entry.where = `${clip(event.filename.split('/').pop() ?? '', 80)}:${event.lineno}`;
        errors.push(entry);
        if (errors.length > ERROR_MAX)
            errors.shift();
        if (options.crashPrompt === false || panelOpen || disposed)
            return;
        const now = performance.now();
        if (now - lastCrashPrompt < 60_000)
            return;
        lastCrashPrompt = now;
        void checkAccess().then((result) => {
            if (result.ok && !panelOpen && !disposed)
                toast('Something went wrong.', { label: 'Send report', run: () => begin('crash') }, 9000);
        });
    };
    const onOnline = () => void flushQueue();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('keypress', onKey, true);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onError);
    window.addEventListener('online', onOnline);
    // Learn early whether this player may send feedback, without competing with startup.
    const warm = window.setTimeout(() => {
        void checkAccess();
        // The HTML-drawing library, so the first screenshot does not wait for it.
        if (options.overlay === undefined)
            loadPageShot().catch(() => undefined);
    }, 4000);
    return {
        open(source = 'manual') {
            begin(source);
        },
        close() {
            closePanel?.();
        },
        isOpen: () => panelOpen,
        breadcrumb(type, data) {
            breadcrumbs.push({ t: Math.round(performance.now()), type: clip(type, 48), ...(data ? { data } : {}) });
            if (breadcrumbs.length > BREADCRUMB_MAX)
                breadcrumbs.shift();
        },
        dispose() {
            if (disposed)
                return;
            closePanel?.();
            disposed = true;
            cancelAnimationFrame(raf);
            window.clearTimeout(warm);
            window.clearTimeout(toastTimer);
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('keyup', onKey, true);
            window.removeEventListener('keypress', onKey, true);
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onError);
            window.removeEventListener('online', onOnline);
            host?.remove();
            host = null;
            root = null;
        },
    };
}
