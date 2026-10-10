// Shared bundler for every DevSuite extension: bundles src/extension.ts plus the shared
// packages (@devsuite/core, @devsuite/vscode-common) from source into dist/extension.js.
const esbuild = require('esbuild');
const path = require('path');

module.exports = async function build(extDir, extraEntries = {}) {
  const production = process.argv.includes('--production');
  const watch = process.argv.includes('--watch');
  const root = path.resolve(__dirname, '..');
  const entries = [{ in: 'src/extension.ts', out: 'extension' }, ...Object.entries(extraEntries).map(([out, inp]) => ({ in: inp, out }))];
  const ctx = await esbuild.context({
    absWorkingDir: extDir,
    entryPoints: entries,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outdir: 'dist',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    alias: {
      '@devsuite/core': path.join(root, 'packages/core/src/index.ts'),
      '@devsuite/vscode-common': path.join(root, 'packages/vscode-common/src/index.ts')
    },
    logLevel: 'info'
  });
  if (watch) await ctx.watch();
  else { await ctx.rebuild(); await ctx.dispose(); }
};
