// Bundles the extension and the standalone pre-commit CLI (dist/cli.js).
require('../../scripts/esbuild-extension')(__dirname, { cli: 'src/cli.ts' }).catch(e => { console.error(e); process.exit(1); });
