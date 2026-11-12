type Library = typeof import('./third_party/modern-screenshot.js');
/** Load the HTML-drawing library (once). A failed load is retried on the next call. */
export declare function loadPageShot(): Promise<Library>;
/**
 * Draw `root` (normally document.body) as the viewport shows it, leaving out `skip` (the canvases
 * already copied, the feedback window) and anything not displayed. Call it in the frame the
 * screenshot is taken: other canvases inside `root`, such as a WebGL preview in a menu, are copied
 * straight away, while their frame is still there. Game frames are held for at most `holdMs`.
 */
export declare function capturePage(root: HTMLElement, skip: readonly Element[], maxWidth: number, holdMs: number): Promise<HTMLCanvasElement | null>;
/**
 * The root's background picture alone (a fixed page backdrop behind the game), to lay under the
 * canvases: in the HTML layer it would cover them. Null when the root has no background image.
 */
export declare function captureBackdrop(root: HTMLElement, maxWidth: number, timeoutMs: number): Promise<HTMLCanvasElement | null>;
/** The colour behind everything on the page, for the parts no canvas or element covers. */
export declare function pageBackground(): string;
export {};
