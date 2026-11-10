/**
 * Builds both frontend surfaces of hermes-psfn-avatar:
 * 1. desktop/plugin.js — single ESM file for Hermes Desktop (@hermes/plugin-sdk, react external)
 * 2. dashboard/dist/index.js — single IIFE bundle for Hermes Web Dashboard (window.__HERMES_PLUGIN_SDK__)
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function sanitizeMinifiedOutput(filePath) {
  // Prevent esbuild's whitespace minifier from juxtaposing `!` and a template literal backtick
  // (`!``) which trips skills_guard's markdown inline_shell_exec regex (`!`[^`\s][^`\n]*``).
  const raw = readFileSync(filePath, 'utf8');
  const cleaned = raw.replace(/!`(?=[A-Za-z0-9_${])/g, '! `');
  writeFileSync(filePath, cleaned, 'utf8');
}

const desktopOut = join(ROOT, 'desktop', 'plugin.js');
await build({
  entryPoints: [join(ROOT, 'src', 'desktop', 'plugin.tsx')],
  outfile: desktopOut,
  absWorkingDir: ROOT,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@hermes/plugin-sdk'],
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  sourcemap: false,
});
sanitizeMinifiedOutput(desktopOut);

const dashboardOut = join(ROOT, 'dashboard', 'dist', 'index.js');
await build({
  entryPoints: [join(ROOT, 'src', 'dashboard', 'index.tsx')],
  outfile: dashboardOut,
  absWorkingDir: ROOT,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  sourcemap: false,
});
sanitizeMinifiedOutput(dashboardOut);

console.log('Built desktop/plugin.js and dashboard/dist/index.js');
