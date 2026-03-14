import * as esbuild from 'esbuild'
import { copyFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

// ── WASM runtime files (fully local — no CDN) ─────────────────────────────────
const ortSrc = resolve(__dirname, 'node_modules/onnxruntime-web/dist')
const tfSrc  = resolve(__dirname, 'node_modules/@xenova/transformers/dist')
const ortDst = resolve(__dirname, 'dist/ort')
mkdirSync(ortDst, { recursive: true })

const wasmFiles = [
  [ortSrc, 'ort-wasm.wasm'],
  [ortSrc, 'ort-wasm-simd.wasm'],
  [ortSrc, 'ort-wasm-simd-threaded.wasm'],
]
for (const [src, file] of wasmFiles) {
  const full = `${src}/${file}`
  if (existsSync(full)) {
    copyFileSync(full, `${ortDst}/${file}`)
    console.log(`✓ ${file} → dist/ort/`)
  }
}

// ── Vendor: bundle @xenova/transformers into one self-contained ESM ───────────
// transformers.min.js uses bare specifiers (onnxruntime-node, etc.) that Chrome
// extension service workers can't resolve. Bundle all JS deps into one file,
// leaving WASM files external to load at runtime via wasmPaths.
const vendorDst = resolve(__dirname, 'dist/vendor')
mkdirSync(vendorDst, { recursive: true })

await esbuild.build({
  entryPoints: [`${tfSrc}/transformers.min.js`],
  bundle: true,
  outfile: 'dist/vendor/transformers.bundle.js',
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  external: ['*.wasm', '*.mjs'],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})
console.log('✓ transformers bundle → dist/vendor/transformers.bundle.js')

// ── esbuild plugin: redirect @xenova/transformers to local bundle ─────────────
const redirectTransformers = {
  name: 'redirect-transformers',
  setup(build) {
    build.onResolve({ filter: /^@xenova\/transformers$/ }, () => ({
      path: './vendor/transformers.bundle.js',
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
