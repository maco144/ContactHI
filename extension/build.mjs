import * as esbuild from 'esbuild'
import { copyFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

// ── Vendor: pre-built transformers.js browser bundle ─────────────────────────
// We use the pre-built bundle rather than re-bundling with esbuild.
// Re-bundling breaks transformers.js internal dynamic module loading.
const tfSrc = resolve(__dirname, 'node_modules/@huggingface/transformers/dist')
const tfDst = resolve(__dirname, 'dist/vendor')
mkdirSync(tfDst, { recursive: true })
copyFileSync(`${tfSrc}/transformers.web.min.js`, `${tfDst}/transformers.min.js`)
console.log('✓ transformers.web.min.js → dist/vendor/transformers.min.js')

// ── WASM runtime files (fully local — no CDN) ─────────────────────────────────
const ortDst = resolve(__dirname, 'dist/ort')
mkdirSync(ortDst, { recursive: true })
const wasmSources = [
  [resolve(__dirname, 'node_modules/onnxruntime-web/dist'), 'ort-wasm-simd-threaded.wasm'],
  [resolve(__dirname, 'node_modules/onnxruntime-web/dist'), 'ort-wasm-simd-threaded.jsep.wasm'],
  [tfSrc, 'ort-wasm-simd-threaded.jsep.mjs'],
]
for (const [src, file] of wasmSources) {
  const full = `${src}/${file}`
  if (existsSync(full)) {
    copyFileSync(full, `${ortDst}/${file}`)
    console.log(`✓ ${file} → dist/ort/`)
  }
}

// ── esbuild plugin: redirect @huggingface/transformers to local pre-built file ─
// The output import becomes: import { ... } from './vendor/transformers.min.js'
// which Chrome resolves relative to dist/background.js → dist/vendor/transformers.min.js
const redirectTransformers = {
  name: 'redirect-transformers',
  setup(build) {
    build.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({
      path: './vendor/transformers.min.js',
      external: true,
    }))
  },
}

const contentEntries = [
  { entryPoints: ['src/content/gmail.ts'], outfile: 'dist/content-gmail.js' },
  { entryPoints: ['src/content/general.ts'], outfile: 'dist/content-general.js' },
  { entryPoints: ['src/popup/popup.ts'], outfile: 'dist/popup.js' },
  { entryPoints: ['src/options/options.ts'], outfile: 'dist/options.js' },
]

const bgConfig = {
  entryPoints: ['src/background/service-worker.ts'],
  outfile: 'dist/background.js',
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: /** @type {const} */ ('esm'),
  plugins: [redirectTransformers],
}

const contentShared = {
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: /** @type {const} */ ('iife'),
}

if (watch) {
  const [bgCtx, ...contentCtxs] = await Promise.all([
    esbuild.context(bgConfig),
    ...contentEntries.map((e) => esbuild.context({ ...contentShared, ...e })),
  ])
  await Promise.all([bgCtx.watch(), ...contentCtxs.map((c) => c.watch())])
  console.log('Watching for changes…')
} else {
  await Promise.all([
    esbuild.build(bgConfig),
    ...contentEntries.map((e) => esbuild.build({ ...contentShared, ...e })),
  ])
  console.log('✓ Build complete')
}
