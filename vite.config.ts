import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(ROOT, 'public', 'assets');

function listAssetFiles(dir: string, base = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listAssetFiles(path.join(dir, entry.name), rel));
    else if (!entry.name.startsWith('.') && !entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
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

export default defineConfig({
  base: './',
  plugins: [assetIndex()],
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
  server: { port: 5173 },
});
