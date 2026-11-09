import type { CrashReport } from '../core/crash';

/**
 * The small "Something broke" panel shown when the game pauses after repeated errors (Reload), or
 * when boot fails (Retry). Every error string is set as text: a message can carry a server response.
 */
export function showCrashPanel(
  report: CrashReport,
  opts: { parent?: HTMLElement; reload?: () => void } = {},
): HTMLElement {
  const doc = (opts.parent ?? document.body).ownerDocument;
  const parent = opts.parent ?? doc.body;
  parent.querySelector(':scope > .crash-panel')?.remove();
  const boot = report.source === 'boot';

  const panel = doc.createElement('div');
  panel.className = 'crash-panel';
  panel.setAttribute('role', 'alertdialog');
  panel.setAttribute('aria-labelledby', 'crash-title');

  const title = doc.createElement('h2');
  title.id = 'crash-title';
  title.textContent = 'Something broke';
  const note = doc.createElement('p');
  note.className = 'note';
  note.textContent = boot
    ? 'The arena could not load. Check your connection and try again.'
    : 'The duel hit an error and paused. Reload to keep playing.';
  const detail = doc.createElement('details');
  const summary = doc.createElement('summary');
  summary.textContent = 'Details';
  const pre = doc.createElement('pre');
  pre.textContent = report.stack && report.stack.includes(report.message)
    ? report.stack
    : [report.message, report.stack].filter(Boolean).join('\n');
  detail.append(summary, pre);

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'primary';
  button.textContent = boot ? 'Retry' : 'Reload';
  button.addEventListener('click', opts.reload ?? (() => location.reload()));

  panel.append(title, note, detail, button);
  parent.appendChild(panel);
  // Pointer lock and focus would otherwise keep the panel out of reach.
  if (doc.pointerLockElement) doc.exitPointerLock?.();
  button.focus();
  return panel;
}
