const esbuild = require('esbuild');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    // Bundle the shared engine straight from source so one build step is enough.
    alias: { '@devsuite/core': path.resolve(__dirname, '../../packages/core/src/index.ts') },
    logLevel: 'info'
  });
  if (watch) await ctx.watch();
  else { await ctx.rebuild(); await ctx.dispose(); }
}

main().catch(e => { console.error(e); process.exit(1); });
