import { resolveImage } from '../assets/AssetLoader';
import { BOSS_PORTRAITS } from '../assets/manifest';
import type { BossDef, BossId } from './levels';

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/** CSS custom properties carrying a boss palette, for cards, ladders and portraits. */
export function bossStyleVars(boss: BossDef): string {
  const p = boss.palette;
  return `--boss-robe:${hex(p.robe)};--boss-trim:${hex(p.trim)};--boss-spell:${hex(p.spell)};--boss-blast:${hex(p.blast)}`;
}

/**
 * The boss portrait: the generated image when `ui/bosses/<id>.png` exists, otherwise a stylized
 * silhouette in the boss's palette over a large monogram (same headgear as the placeholder model).
 */
export function bossPortraitHtml(boss: BossDef, cls = ''): string {
  const url = resolveImage(BOSS_PORTRAITS[boss.id]);
  const style = bossStyleVars(boss);
  if (url) return `<div class="boss-portrait ${cls}" style="${style}"><img src="${url}" alt="${boss.name}" draggable="false"></div>`;
  return `<div class="boss-portrait fallback ${cls}" style="${style}" role="img" aria-label="${boss.name}">${silhouetteSvg(boss)}</div>`;
}

let uid = 0;

function silhouetteSvg(boss: BossDef): string {
  const p = boss.palette;
  const robe = hex(p.robe), trim = hex(p.trim), spell = hex(p.spell), blast = hex(p.blast);
  const id = `bp${++uid}`;
  const green = boss.id === 'broccoli';
  const face = FACES[boss.id];
  return `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <radialGradient id="${id}bg" cx="50%" cy="38%" r="70%">
          <stop offset="0" stop-color="${spell}" stop-opacity="0.55"/>
          <stop offset="0.45" stop-color="${robe}" stop-opacity="0.55"/>
          <stop offset="1" stop-color="#05030a"/>
        </radialGradient>
        <linearGradient id="${id}robe" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${robe}"/>
          <stop offset="1" stop-color="#05030a"/>
        </linearGradient>
        <filter id="${id}glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.6" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <rect width="100" height="100" fill="url(#${id}bg)"/>
      <text x="50" y="78" text-anchor="middle" font-family="Cinzel, Georgia, serif" font-weight="800" font-size="86"
        fill="${trim}" opacity="0.13">${boss.name[0]}</text>
      <path d="M10 100 C14 78 30 67 50 67 C70 67 86 78 90 100 Z" fill="url(#${id}robe)" stroke="${trim}" stroke-opacity="0.5" stroke-width="0.8"/>
      <path d="M38 69 Q50 76 62 69" fill="none" stroke="${trim}" stroke-width="2.2" stroke-linecap="round"/>
      ${front(boss.id, robe, trim, spell)}
      <circle cx="50" cy="55" r="11.5" fill="${face}"/>
      ${green ? `<circle cx="45.5" cy="54" r="3" fill="#120c1c"/><circle cx="54.5" cy="54" r="3" fill="#120c1c"/>` : ''}
      <g filter="url(#${id}glow)">
        <circle cx="45.5" cy="54" r="1.7" fill="${spell}"/>
        <circle cx="54.5" cy="54" r="1.7" fill="${spell}"/>
        ${headgear(boss.id, robe, trim, spell, blast)}
      </g>
    </svg>`;
}

/** Face fill per boss: dark silhouettes, and Broccoli Head's pale green stalk. */
const FACES: Record<BossId, string> = {
  sahil: '#2a1810',
  obama: '#1c120c',
  broccoli: '#86ad55',
  agent: '#241a18',
  tinubu: '#1e100a',
};

/** Body cues drawn over the shoulders, under the head. */
function front(id: BossId, robe: string, trim: string, spell: string): string {
  switch (id) {
    case 'sahil': // a round belly under a sash
      return `<ellipse cx="50" cy="91" rx="30" ry="20" fill="${robe}" stroke="${trim}" stroke-opacity="0.6" stroke-width="0.8"/>
        <path d="M24 85 Q50 74 76 85" fill="none" stroke="${trim}" stroke-width="3"/>`;
    case 'obama': // long black coat over a shirt, a gold chain and a coin
      return `<path d="M44 67 L50 82 L56 67 Z" fill="#e8e4dc"/>
        <path d="M44 67 L50 82 L40 77 Z M56 67 L50 82 L60 77 Z" fill="${robe}" stroke="${trim}" stroke-opacity="0.4" stroke-width="0.5"/>
        <path d="M40 70 Q50 86 60 70" fill="none" stroke="${trim}" stroke-width="1"/>
        <circle cx="50" cy="83" r="3.2" fill="${spell}"/>`;
    case 'agent': // black suit, white shirt, black tie
      return `<path d="M45 67 L50 80 L55 67 Z" fill="#f1f1f1"/>
        <path d="M49 69 L51 69 L52 79 L50 82 L48 79 Z" fill="#0b0b0e"/>
        <path d="M45 67 L50 80 L40 76 Z M55 67 L50 80 L60 76 Z" fill="${robe}" stroke="#8a8f99" stroke-opacity="0.5" stroke-width="0.5"/>`;
    case 'tinubu': // wide agbada shoulders
      return `<ellipse cx="27" cy="76" rx="12" ry="5" fill="${robe}" stroke="${trim}" stroke-width="0.8"/>
        <ellipse cx="73" cy="76" rx="12" ry="5" fill="${robe}" stroke="${trim}" stroke-width="0.8"/>`;
    default:
      return '';
  }
}

/** Headgear and face cues, drawn over the face and eyes (in the glow group). */
function headgear(id: BossId, robe: string, trim: string, spell: string, blast: string): string {
  switch (id) {
    case 'sahil': {
      // Bushy beard, moustache and brows; a small red fez with a tassel.
      const hair = '#2a1a10';
      return `
        <path d="M38.5 55 Q36 71 50 75 Q64 71 61.5 55 Q58 64.5 50 65 Q42 64.5 38.5 55 Z" fill="${hair}"/>
        <path d="M42.5 61.5 Q50 57 57.5 61.5 Q50 60.2 42.5 61.5 Z" fill="${hair}"/>
        <path d="M41.8 50.6 L48 51.6 M58.2 50.6 L52 51.6" stroke="${hair}" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M42.5 45 L44.5 33 L55.5 33 L57.5 45 Z" fill="#b3122a"/>
        <ellipse cx="50" cy="33" rx="5.5" ry="1.2" fill="#8a0e20"/>
        <path d="M50 33 Q56 34 57 40" fill="none" stroke="#1a1010" stroke-width="0.9"/>
        <circle cx="57" cy="40.5" r="1.3" fill="${spell}"/>`;
    }
    case 'obama':
      // Mustard wide-brim hat.
      return `
        <ellipse cx="50" cy="45" rx="25" ry="4.6" fill="#c9a032"/>
        <path d="M38.5 45 L40 31 Q50 28 60 31 L61.5 45 Z" fill="#c9a032"/>
        <path d="M39.2 41 L60.8 41 L61.2 44.6 L38.8 44.6 Z" fill="#2a2214"/>`;
    case 'broccoli': {
      // A head of broccoli florets instead of a hat.
      const florets = [[50, 36, 9], [40, 40, 7], [60, 40, 7], [33, 46, 5.5], [67, 46, 5.5], [44, 30, 6], [56, 30, 6], [50, 25, 5]]
        .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${robe}" stroke="${trim}" stroke-opacity="0.55" stroke-width="0.6"/>
          <circle cx="${x - r * 0.3}" cy="${y - r * 0.3}" r="${r * 0.35}" fill="${spell}" opacity="0.8"/>`)
        .join('');
      return florets;
    }
    case 'agent':
      // Slicked short hair, dark sunglasses with a glint, an earpiece. No hat.
      return `
        <path d="M38.6 53 Q38 41 50 41.5 Q62 41 61.4 53 Q58 46 50 46 Q42 46 38.6 53 Z" fill="#1a1410"/>
        <rect x="40.5" y="51.2" width="8.5" height="5" rx="1.5" fill="#050608"/>
        <rect x="51" y="51.2" width="8.5" height="5" rx="1.5" fill="#050608"/>
        <rect x="48.5" y="52.2" width="3" height="1" fill="#050608"/>
        <path d="M42 52.6 L44.6 52.6" stroke="${spell}" stroke-width="0.8"/>
        <path d="M61 56 Q64 62 62 68" fill="none" stroke="#cfd4da" stroke-width="0.6"/>`;
    case 'tinubu':
      // Tall fila cap folded to one side with a gold emblem; small red horns.
      return `
        <path d="M32.5 38 Q33 44 39.6 47 L41 44.4 Q36 43 32.5 38 Z" fill="#b3141a"/>
        <path d="M67.5 38 Q67 44 60.4 47 L59 44.4 Q64 43 67.5 38 Z" fill="#b3141a"/>
        <path d="M39.5 46 L38 28 Q49 22 61.5 26.5 L60.5 46 Z" fill="${robe}" stroke="${trim}" stroke-opacity="0.5" stroke-width="0.6"/>
        <path d="M38 28 Q49 22 61.5 26.5 Q61 31 67 33.5 Q55 36 38 28 Z" fill="${robe}" stroke="${trim}" stroke-opacity="0.4" stroke-width="0.5"/>
        <circle cx="50" cy="38" r="3.3" fill="${trim}"/>
        <circle cx="50" cy="38" r="1.6" fill="${blast}"/>`;
    default:
      return '';
  }
}
