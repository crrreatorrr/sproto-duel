/**
 * The menus' Full Screen option: the browser Fullscreen API on the whole page. The game already
 * fills the window; this takes the browser's own bars away too. Requests must come from the
 * click / key handler itself (a user gesture); a gamepad press is not one in most browsers, so a
 * refused request reports false and the menu says how to do it instead.
 */

/** The browser can put the page in full screen (false in some iframes and on iOS Safari). */
export function fullscreenSupported(doc: Document = document): boolean {
  return !!doc.fullscreenEnabled && typeof doc.documentElement.requestFullscreen === 'function';
}

export function isFullscreen(doc: Document = document): boolean {
  return !!doc.fullscreenElement;
}

/**
 * Enter or leave full screen. Resolves true when the browser did it, false when it refused (no
 * user gesture, blocked by policy). Never throws.
 */
export async function toggleFullscreen(doc: Document = document): Promise<boolean> {
  try {
    if (doc.fullscreenElement) await doc.exitFullscreen();
    else await doc.documentElement.requestFullscreen({ navigationUI: 'hide' });
    return true;
  } catch {
    return false;
  }
}

let exitedAt = -1e9;
if (typeof document !== 'undefined') {
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) exitedAt = performance.now();
  });
}

/**
 * True for an Esc press that is (or just was) the browser leaving full screen. Esc in full screen
 * always exits it, so the game's own Esc (Back, pause) waits for the next press instead of both
 * happening at once.
 */
export function escLeavesFullscreen(e: KeyboardEvent, doc: Document = document): boolean {
  if (e.code !== 'Escape') return false;
  return !!doc.fullscreenElement || performance.now() - exitedAt < 250;
}
