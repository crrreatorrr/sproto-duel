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
  const skull = boss.id === 'broccoli';
  const face = skull ? '#cfc8b4' : '#120c1c';
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
      ${behindHead(boss.id, robe, trim)}
      <circle cx="50" cy="55" r="11.5" fill="${face}"/>
      ${skull ? `<circle cx="45.5" cy="54" r="3.2" fill="#120c1c"/><circle cx="54.5" cy="54" r="3.2" fill="#120c1c"/>` : ''}
      <g filter="url(#${id}glow)">
        <circle cx="45.5" cy="54" r="1.7" fill="${spell}"/>
        <circle cx="54.5" cy="54" r="1.7" fill="${spell}"/>
        ${headgear(boss.id, robe, trim, spell, blast)}
      </g>
    </svg>`;
}

/** Hoods sit behind the face. */
function behindHead(id: BossId, robe: string, trim: string): string {
  if (id === 'agent' || id === 'broccoli') {
    const w = id === 'broccoli' ? 17 : 15;
    return `<path d="M${50 - w} 68 Q${50 - w - 3} 36 50 33 Q${50 + w + 3} 36 ${50 + w} 68 Q${50 + w * 0.6} 52 50 50 Q${50 - w * 0.6} 52 ${50 - w} 68 Z"
      fill="${robe}" stroke="${trim}" stroke-opacity="0.45" stroke-width="0.8"/>`;
  }
  if (id === 'sahil') {
    return `<path d="M37 46 L35 66 L41 66 L42 50 Z M63 46 L65 66 L59 66 L58 50 Z" fill="${trim}"/>`;
  }
  return '';
}

function headgear(id: BossId, robe: string, trim: string, spell: string, blast: string): string {
  switch (id) {
    case 'obama': {
      const leaves = [-22, -14, -6, 6, 14, 22]
        .map((dx, i) => `<ellipse cx="${50 + dx}" cy="${45.5 + (i % 2)}" rx="3.6" ry="1.6" fill="${spell}" transform="rotate(${dx * 1.2} ${50 + dx} 46)"/>`)
        .join('');
      return `
        <ellipse cx="50" cy="45" rx="27" ry="5" fill="${trim}"/>
        <path d="M36 45 Q38 24 60 16 Q55 28 64 45 Z" fill="${trim}"/>
        <path d="M36.5 43 Q50 47 63.5 43" fill="none" stroke="${robe}" stroke-width="2.4"/>
        ${leaves}
        <circle cx="62" cy="43" r="2.2" fill="${blast}"/>`;
    }
    case 'tinubu':
      return `
        <path d="M41 47 Q29 41 29 27 Q35 38 45 44 Z" fill="#2a1712" stroke="${trim}" stroke-width="0.6"/>
        <path d="M59 47 Q71 41 71 27 Q65 38 55 44 Z" fill="#2a1712" stroke="${trim}" stroke-width="0.6"/>
        <path d="M50 18 Q59 30 55 38 Q61 35 60 28 Q67 39 59 46 L41 46 Q33 39 41 29 Q40 36 45 39 Q42 29 50 18 Z" fill="${spell}"/>
        <path d="M50 28 Q55 35 53 41 L47 41 Q45 35 50 28 Z" fill="${blast}"/>
        <ellipse cx="27" cy="75" rx="9" ry="5" fill="${trim}" opacity="0.85"/>
        <ellipse cx="73" cy="75" rx="9" ry="5" fill="${trim}" opacity="0.85"/>`;
    case 'agent': {
      const spikes = [-12, -8, -4, 0, 4, 8, 12]
        .map((dx, i) => {
          const h = i % 2 ? 7 : 12;
          return `<path d="M${50 + dx - 1.8} 37 L${50 + dx * 1.15} ${37 - h} L${50 + dx + 1.8} 37 Z" fill="#e8f2ff"/>`;
        })
        .join('');
      return `${spikes}<path d="M48 40 L50 37 L52 40 L50 43 Z" fill="${spell}"/>
        <path d="M33 70 L36 60 L64 60 L67 70" fill="none" stroke="${trim}" stroke-width="2.4"/>`;
    }
    case 'sahil':
      return `
        <path d="M37 48 L34 27 L66 27 L63 48 Z" fill="${trim}"/>
        <rect x="34.5" y="31" width="31" height="3" fill="${robe}"/>
        <rect x="36" y="41" width="28" height="3" fill="${robe}"/>
        <circle cx="50" cy="37" r="3.6" fill="${spell}"/>
        <path d="M24 76 Q50 64 76 76" fill="none" stroke="${trim}" stroke-width="4"/>`;
    case 'broccoli': {
      const spikes = [-14, -8, -2, 4, 10]
        .map((dx, i) => `<path d="M${53 + dx - 1.6} 30 L${53 + dx} ${30 - (i % 2 ? 6 : 10)} L${53 + dx + 1.6} 30 Z" fill="${trim}"/>`)
        .join('');
      return `<ellipse cx="50" cy="30" rx="15" ry="2.6" fill="none" stroke="${trim}" stroke-width="1.6"/>${spikes}
        <path d="M26 74 L22 64 L30 71 Z M74 74 L78 64 L70 71 Z" fill="#d9d3c2"/>`;
    }
    default:
      return '';
  }
}
