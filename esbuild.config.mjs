import builtins from 'builtin-modules';
import esbuild from 'esbuild';
import { copyFileSync } from 'fs';
import process from 'process';

const prod = process.argv[2] === 'production';

const VAULT_PLUGIN_DIR =
  'C:/Users/罗宇峰/Desktop/Obsidian Plugin Devlopment/.obsidian/plugins/optimized Zotero integration';

const context = await esbuild.context({
  entryPoints: ['./src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/closebrackets',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/comment',
    '@codemirror/fold',
    '@codemirror/gutter',
    '@codemirror/highlight',
    '@codemirror/history',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/matchbrackets',
    '@codemirror/panel',
    '@codemirror/rangeset',
    '@codemirror/rectangular-selection',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/stream-parser',
    '@codemirror/text',
    '@codemirror/tooltip',
    '@codemirror/view',
    'node:*',
    ...builtins,
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
});

if (prod) {
  await context.rebuild();
  // Deploy to Obsidian vault plugin directory
  try {
    copyFileSync('main.js', `${VAULT_PLUGIN_DIR}/main.js`);
    copyFileSync('manifest.json', `${VAULT_PLUGIN_DIR}/manifest.json`);
    copyFileSync('styles.css', `${VAULT_PLUGIN_DIR}/styles.css`);
    console.log('✅ Deployed to vault plugin directory');
  } catch (e) {
    console.error('⚠️ Failed to deploy to vault:', e.message);
  }
  process.exit(0);
} else {
  await context.watch();
}
