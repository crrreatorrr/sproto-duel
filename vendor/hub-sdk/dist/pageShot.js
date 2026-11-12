// The HTML half of the feedback screenshot (docs/feedback.md). The canvases are copied in
// feedback.ts; this draws the rest of the page (menus, HUD, panels: plain HTML in most games) into
// a whole-viewport canvas, transparent where the canvases show through, to lay over them.
//
// The drawing is done by modern-screenshot, vendored in ./third_party (MIT). It is a separate
// module loaded on demand, and fetched a few seconds after start so the first N-N does not wait.
/**
 * How long the library waits for each image and font fetch. It waits for every <img> on the page,
 * shown or not, and a hidden `loading="lazy"` image (a closed menu's portraits, in the hub) never
 * loads, so this is paid in full whenever a page has one. Images on screen are already loaded, and
 * fonts come from the browser's cache after the first time.
 */
const MEDIA_WAIT_MS = 1000;
/** Marks a container of a canvas copied directly while the page is drawn (see capturePage). */
const UNDER = 'data-hub-feedback-under';
/** Marks a selected <option> or a checked box while the page is drawn (see capturePage). */
const CHOSEN = 'data-hub-feedback-chosen';
/** Marks an element with auto margins while the page is drawn: its value lists the sides. */
const AUTO = 'data-hub-feedback-auto';
const SIDES = ['top', 'right', 'bottom', 'left'];
let library = null;
/** Load the HTML-drawing library (once). A failed load is retried on the next call. */
export function loadPageShot() {
    library ??= import('./third_party/modern-screenshot.js').catch((error) => {
        library = null;
        throw error;
    });
    return library;
}
/**
 * Hold `requestAnimationFrame` callbacks until the returned function is called, then hand them to
 * the browser. The library yields between nodes, and a game frame drawn in each gap made the copy
 * many times slower (seconds instead of a fraction of one). The screen keeps the last frame.
 */
function holdFrames() {
    const w = window;
    const request = w.requestAnimationFrame;
    const cancel = w.cancelAnimationFrame;
    const queued = new Map();
    let next = 0;
    w.requestAnimationFrame = (callback) => {
        next -= 1;
        queued.set(next, callback);
        return next;
    };
    w.cancelAnimationFrame = (handle) => {
        if (!queued.delete(handle))
            cancel.call(w, handle);
    };
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        w.requestAnimationFrame = request;
        w.cancelAnimationFrame = cancel;
        for (const callback of queued.values())
            request.call(w, callback);
    };
}
/**
 * Draw `root` (normally document.body) as the viewport shows it, leaving out `skip` (the canvases
 * already copied, the feedback window) and anything not displayed. Call it in the frame the
 * screenshot is taken: other canvases inside `root`, such as a WebGL preview in a menu, are copied
 * straight away, while their frame is still there. Game frames are held for at most `holdMs`.
 */
export function capturePage(root, skip, maxWidth, holdMs) {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    // A WebGL canvas without preserveDrawingBuffer is blank once this frame is shown. Copy each one
    // now with drawImage (about 1 ms; toDataURL on WebGL stalls on the GPU, for seconds in a
    // software-rendered browser) and answer the library's later read from the copy.
    const frozen = [];
    for (const canvas of Array.from(root.querySelectorAll('canvas'))) {
        if (skip.includes(canvas) || !canvas.width || !canvas.height || offscreen(canvas, width, height))
            continue;
        try {
            const copy = document.createElement('canvas');
            copy.width = canvas.width;
            copy.height = canvas.height;
            const g = copy.getContext('2d');
            if (!g)
                continue;
            g.drawImage(canvas, 0, 0);
            canvas.toDataURL = (...args) => copy.toDataURL(...args);
            frozen.push(canvas);
        }
        catch {
            // A lost or tainted canvas: the library skips it.
        }
    }
    // On the page the canvases are painted over their containers' backgrounds; in the screenshot the
    // HTML goes over the canvases, so an opaque container (the hub's #app) would hide them. Mark each
    // container of a copied canvas and clear its background in the copy. Attributes do not repaint.
    const under = [];
    for (const node of skip) {
        if (!(node instanceof HTMLCanvasElement))
            continue;
        for (let parent = node.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
            if (!parent.hasAttribute(UNDER)) {
                parent.setAttribute(UNDER, '');
                under.push(parent);
            }
        }
    }
    // The copy keeps attributes, not live state: a <select> showed its first option (or nothing) and
    // a ticked box showed empty. Mark the chosen ones and set `selected`/`checked` in the copy.
    const chosen = [];
    for (const node of Array.from(root.querySelectorAll('option, input'))) {
        const on = node instanceof HTMLOptionElement ? node.selected : node instanceof HTMLInputElement && (node.type === 'checkbox' || node.type === 'radio') && node.checked;
        if (on) {
            node.setAttribute(CHOSEN, '');
            chosen.push(node);
        }
    }
    // The copy carries computed styles, not the page's stylesheets, and an auto margin computes to a
    // number of pixels (0 for a grid or flex item), so a button centred with `margin: auto` came out
    // at the left. computedStyleMap still says `auto` (Chromium and Safari; elsewhere this is
    // skipped). Mark those elements and put the auto margins back in the copy.
    const autos = [];
    for (const node of Array.from(root.querySelectorAll('*'))) {
        if (typeof node.computedStyleMap !== 'function')
            break;
        let sides = '';
        try {
            const map = node.computedStyleMap();
            for (const side of SIDES)
                if (String(map.get(`margin-${side}`)) === 'auto')
                    sides += side[0];
        }
        catch {
            break;
        }
        if (sides) {
            node.setAttribute(AUTO, sides);
            autos.push(node);
        }
    }
    // The library always lays the copy out with the browser's default body margin (8px) and drops
    // the page's own, so a page with `body { margin: 0 }` came out 8px right and down. It also draws
    // the document from its top, so a scrolled page came out shifted by the scroll; take the scroll
    // off the margin (fixed elements are placed against the viewport and do not move).
    const rootStyle = getComputedStyle(root);
    const margin = `${parseFloat(rootStyle.marginTop) - window.scrollY}px ${rootStyle.marginRight} ${rootStyle.marginBottom} ${parseFloat(rootStyle.marginLeft) - window.scrollX}px`;
    const release = holdFrames();
    const deadline = window.setTimeout(release, holdMs);
    const done = () => {
        window.clearTimeout(deadline);
        release();
        for (const parent of under)
            parent.removeAttribute(UNDER);
        for (const node of chosen)
            node.removeAttribute(CHOSEN);
        for (const node of autos)
            node.removeAttribute(AUTO);
        for (const canvas of frozen)
            delete canvas.toDataURL;
    };
    return loadPageShot()
        .then(({ domToCanvas }) => domToCanvas(root, {
        width,
        height,
        scale: Math.min(1, maxWidth / width),
        backgroundColor: null,
        // The root's own background is behind the canvases on the page, not over them (see
        // captureBackdrop for its picture).
        style: { background: 'transparent', margin },
        timeout: Math.min(MEDIA_WAIT_MS, holdMs),
        onCloneEachNode: (cloned) => {
            if (!(cloned instanceof HTMLElement))
                return;
            if (cloned.hasAttribute(UNDER))
                cloned.style.setProperty('background', 'none', 'important');
            const sides = cloned.getAttribute(AUTO);
            if (sides !== null) {
                for (const side of SIDES)
                    if (sides.includes(side[0]))
                        cloned.style.setProperty(`margin-${side}`, 'auto');
                cloned.removeAttribute(AUTO);
            }
            if (cloned instanceof HTMLOptionElement || cloned instanceof HTMLInputElement) {
                const attribute = cloned instanceof HTMLOptionElement ? 'selected' : 'checked';
                if (cloned.hasAttribute(CHOSEN))
                    cloned.setAttribute(attribute, '');
                else
                    cloned.removeAttribute(attribute);
                cloned.removeAttribute(CHOSEN);
            }
        },
        filter: (node) => !(node instanceof Element) || (!skip.includes(node) && visible(node) && !hidden(node, width, height)),
    }))
        .catch(() => null)
        .finally(done);
}
/**
 * The root's background picture alone (a fixed page backdrop behind the game), to lay under the
 * canvases: in the HTML layer it would cover them. Null when the root has no background image.
 */
export function captureBackdrop(root, maxWidth, timeoutMs) {
    if (getComputedStyle(root).backgroundImage === 'none')
        return Promise.resolve(null);
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    return loadPageShot()
        .then(({ domToCanvas }) => domToCanvas(root, {
        width,
        height,
        scale: Math.min(1, maxWidth / width),
        backgroundColor: null,
        // On the page the body's background fills the whole viewport, whatever its margin.
        style: { margin: '0' },
        timeout: Math.min(MEDIA_WAIT_MS, timeoutMs),
        filter: () => false,
    }))
        .catch(() => null);
}
/** Entirely outside the viewport. */
function offscreen(node, width, height) {
    const r = node.getBoundingClientRect();
    return r.right <= 0 || r.bottom <= 0 || r.left >= width || r.top >= height;
}
/**
 * Leave out what cannot show and is slow to copy: an image or canvas outside the viewport, an image
 * that has not loaded (a lazy one off screen is fetched again for every screenshot), and a box
 * outside the viewport that clips its content. A long menu page took several seconds without this
 * and missed the window's wait.
 */
function hidden(node, width, height) {
    if (node instanceof HTMLImageElement)
        return !node.complete || node.naturalWidth === 0 || offscreen(node, width, height);
    if (node instanceof HTMLCanvasElement || node instanceof HTMLVideoElement || node instanceof SVGSVGElement)
        return offscreen(node, width, height);
    if (!(node instanceof HTMLElement) || node.tagName === 'BODY' || node.tagName === 'HTML')
        return false;
    if (!offscreen(node, width, height))
        return false;
    const style = getComputedStyle(node);
    return style.overflowX !== 'visible' && style.overflowY !== 'visible';
}
/** Element.checkVisibility, or the computed display where it is missing (Safari before 17.4). */
function visible(node) {
    // An <option> has no box of its own, so it never counts as visible, but its <select> shows it.
    if (node instanceof HTMLOptionElement || node instanceof HTMLOptGroupElement)
        return true;
    if (typeof node.checkVisibility === 'function')
        return node.checkVisibility();
    return getComputedStyle(node).display !== 'none';
}
/** The colour behind everything on the page, for the parts no canvas or element covers. */
export function pageBackground() {
    for (const node of [document.body, document.documentElement]) {
        if (!node)
            continue;
        const color = getComputedStyle(node).backgroundColor;
        if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color))
            return color;
    }
    return '#000';
}
