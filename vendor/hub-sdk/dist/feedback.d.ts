import type { HubSdk } from './types';
export declare const FEEDBACK_CATEGORIES: readonly [{
    readonly id: "broke";
    readonly label: "Something broke";
}, {
    readonly id: "unclear";
    readonly label: "Unclear what to do";
}, {
    readonly id: "too_hard";
    readonly label: "Too hard";
}, {
    readonly id: "too_easy";
    readonly label: "Too easy";
}, {
    readonly id: "controls";
    readonly label: "Controls feel off";
}, {
    readonly id: "performance";
    readonly label: "Performance issue";
}, {
    readonly id: "other";
    readonly label: "Other";
}];
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]['id'];
/** Server limits (server/modules/src/games/hub_feedback.ts). */
export declare const FEEDBACK_NOTE_MAX = 2000;
export declare const FEEDBACK_IMAGE_MAX = 190000;
export declare const FEEDBACK_META_MAX = 15000;
export interface FeedbackSubmission {
    categories: FeedbackCategory[];
    note: string;
    /** JPEG data URL, or '' when no screenshot could be taken. */
    image: string;
    /** ISO time on the player's clock when the window opened. */
    clientTime: string;
    source: 'manual' | 'crash';
    meta: Record<string, unknown>;
}
export interface FeedbackAccess {
    ok: boolean;
    /** `standalone`, `sign_in_required`, `offline` or a server code. */
    reason?: string;
    username?: string;
}
export interface FeedbackTransport {
    access(): Promise<FeedbackAccess>;
    submit(input: FeedbackSubmission): Promise<{
        id: string;
    }>;
}
/** What the game knows about "right now". Every field is optional. */
export interface FeedbackContext {
    level?: string;
    mode?: string;
    /** World position of the player. `z` is optional for 2D games. */
    position?: {
        x: number;
        y: number;
        z?: number;
    };
    /** Seconds of in-game time (run or level clock). */
    gameTime?: number;
    /** Player state worth knowing: health, lives, weapon, score, flags. */
    player?: Record<string, unknown>;
    /** Anything else that helps: seed, boss phase, difficulty, online role. */
    extra?: Record<string, unknown>;
}
export interface FeedbackTheme {
    font: string;
    titleFont: string;
    background: string;
    panel: string;
    text: string;
    muted: string;
    accent: string;
    accentText: string;
    border: string;
    radius: string;
    /** Extra CSS appended inside the window's shadow root. */
    css: string;
}
export interface FeedbackOptions {
    /** Display name in the window title, e.g. "Sproto Shooter". */
    title: string;
    transport: FeedbackTransport;
    /** Game version or build id. */
    version?: string;
    /**
     * Pause the game. Return `false` when it cannot pause (an online match): the window then says
     * the game keeps running. Any other value is handed back to `resume`.
     */
    pause?(): unknown;
    resume?(token: unknown): void;
    context?(): FeedbackContext;
    /**
     * Called right before the screenshot. A WebGL game without `preserveDrawingBuffer` whose loop
     * is not running (already paused) renders one frame here so the canvas is not blank.
     */
    beforeCapture?(): void;
    /** Canvases to capture, back to front. Default: every visible canvas on the page. */
    canvases?(): HTMLCanvasElement[];
    /**
     * The screenshot shows the whole page: the canvases, then the page's HTML (menus, HUD, panels)
     * drawn over them. By default the SDK draws the HTML itself (document.body, minus the canvases
     * above and anything not displayed). Pass a function to draw it yourself instead: return a
     * canvas covering the whole viewport, transparent where the canvases show through, or null; it
     * may be async. Pass `false` for canvases only. The window waits for the HTML at most 3 s.
     */
    overlay?: false | (() => HTMLCanvasElement | null | Promise<HTMLCanvasElement | null>);
    /** Recent errors from the game's own crash guard, newest last. Added to the ones caught here. */
    errors?(): unknown[];
    /** Return false to ignore the shortcut right now (a text prompt of the game's own is open). */
    enabled?(): boolean;
    theme?: Partial<FeedbackTheme>;
    /** `KeyboardEvent.code` of the shortcut. Default `KeyN`. */
    key?: string;
    /** Longest gap between the two presses, in ms. Default 400. */
    doubleTapMs?: number;
    /** Offer "Send report?" after an uncaught error. Default true. */
    crashPrompt?: boolean;
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
    onOpen?(): void;
    onClose?(): void;
}
export interface FeedbackHandle {
    /** Open the window now (pause-menu button, gamepad shortcut). */
    open(source?: 'manual' | 'crash'): void;
    close(): void;
    isOpen(): boolean;
    /** Record a small game event (level start, death, boss phase). The last 24 are attached. */
    breadcrumb(type: string, data?: Record<string, unknown>): void;
    dispose(): void;
}
/** Feedback over a hub SDK instance. Standalone play and older SDK doubles answer `standalone`. */
export declare function feedbackTransportFromSdk(sdk: HubSdk): FeedbackTransport;
/** Fit `meta` under the server cap by dropping the bulkiest optional parts first. */
export declare function fitFeedbackMeta(meta: Record<string, unknown>, max?: number): Record<string, unknown>;
/**
 * Install the feedback shortcut and window. Call once at startup. Returns a no-op handle
 * outside a browser.
 */
export declare function installFeedback(options: FeedbackOptions): FeedbackHandle;
