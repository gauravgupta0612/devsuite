// Cross-platform test bundle (the esbuild CLI with --alias misbehaves under Windows cmd.exe).
const path = require('path');
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, 'entry.ts')],
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'error',
  outfile: path.join(__dirname, '..', 'out-test', 'store.js'),
  alias: { '@devsuite/core': path.join(__dirname, '..', '..', '..', 'packages', 'core', 'src', 'index.ts') }
});
