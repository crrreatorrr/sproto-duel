/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(ROOT, 'public', 'assets');

/**
 * Files under public/assets that stay in git (authoring and reference copies) but that the game
 * never loads: left out of `virtual:asset-index` and deleted from dist/ after a build.
 * - the full-detail staff GLBs (2048² textures): the game loads the `-lod1` props only
 *   (staffModelPath); tools/blender/finish-staff.mjs writes both,
 * - ui/player.png: a portrait nothing displays.
 */
export const ARCHIVED_ASSETS: readonly RegExp[] = [/^models\/staffs\/staff_(?!.*-lod1\.glb$)[^/]+\.glb$/, /^ui\/player\.png$/];

export const isArchivedAsset = (rel: string) => ARCHIVED_ASSETS.some((re) => re.test(rel));

function listAssetFiles(dir: string, base = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listAssetFiles(path.join(dir, entry.name), rel));
    else if (!entry.name.startsWith('.') && !entry.name.endsWith('.md') && !isArchivedAsset(rel)) out.push(rel);
  }
  return out;
}

/** Drops ARCHIVED_ASSETS and the folder READMEs from the copy of public/assets in dist/. */
function pruneArchivedAssets(): Plugin {
  let outDir = '';
  return {
    name: 'prune-archived-assets',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const dir = path.join(outDir, 'assets');
      const walk = (d: string, base = '') => {
        if (!fs.existsSync(d)) return;
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const rel = base ? `${base}/${entry.name}` : entry.name;
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) walk(p, rel);
          else if (entry.name.endsWith('.md') || isArchivedAsset(rel)) fs.rmSync(p);
        }
      };
      walk(dir);
    },
  };
}

/**
 * Exposes `virtual:asset-index`: the list of files that actually exist under public/assets.
 * The asset loader only fetches files on this list and uses placeholders for everything else,
 * so dropping a GLB/texture/sound at its manifest path is enough to swap it in.
 */
function assetIndex(): Plugin {
  const VIRTUAL_ID = 'virtual:asset-index';
  const RESOLVED_ID = '\0' + VIRTUAL_ID;
  return {
    name: 'asset-index',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      return `export default ${JSON.stringify(listAssetFiles(ASSET_DIR))};`;
    },
    configureServer(server) {
      server.watcher.add(ASSET_DIR);
      const onChange = (file: string) => {
        if (!file.startsWith(ASSET_DIR)) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);
    },
  };
}

/**
 * Public base path. Unset (the default) stays `./`, so one build is served both from the dev
 * path `/play/sproto-duel/` and from production `https://play.<domain>/sproto-duel/`.
 * Asset URLs are `import.meta.env.BASE_URL` plus a relative path, never a leading `/`.
 */
function resolveBase(mode: string): string {
  const fromFile = loadEnv(mode, ROOT, 'VITE_').VITE_BASE;
  const raw = (process.env.VITE_BASE ?? fromFile ?? '').trim();
  if (!raw || raw === '.' || raw === './') return './';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

/** `<package version>+<short commit>` for feedback notes: CI's GITHUB_SHA, else git, else `dev`. */
function buildId(): string {
  const version = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  let commit = (process.env.GITHUB_SHA ?? '').trim().slice(0, 7);
  if (!commit) {
    try {
      commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      commit = '';
    }
  }
  return `${version}+${commit || 'dev'}`;
}

export default defineConfig(({ mode }) => ({
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  base: resolveBase(mode),
  plugins: [assetIndex(), pruneArchivedAssets()],
  build: {
    // public/assets holds game assets, so keep bundled JS/CSS in a separate folder.
    assetsDir: 'build',
    target: 'es2022',
    // Rapier inlines its WebAssembly (~2 MB). Separate vendor chunks load in parallel and stay
    // cached across game updates.
    chunkSizeWarningLimit: 4500,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'rapier', test: /@dimforge/ },
            { name: 'three', test: /node_modules[\\/]three/ },
          ],
        },
      },
    },
  },
  test: {
    // Agent worktrees and QA snapshots are copies of the repo: never collect their tests.
    exclude: ['**/node_modules/**', '**/.claude/**', '**/.qa-build/**', '**/dist/**'],
  },
  server: {
    port: 5173,
    // Agent worktrees and QA snapshots live inside the project folder; don't watch them.
    watch: { ignored: ['**/.claude/**', '**/.qa-build/**'] },
  },
}));
