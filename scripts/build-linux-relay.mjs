import { build } from 'esbuild'
await build({ entryPoints: ['multiplayer-relay/start.mjs'], outfile: 'output/linux-relay/relay.mjs', bundle: true, platform: 'node', target: 'node24', format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } })
