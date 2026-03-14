import * as esbuild from 'esbuild'
import { copyFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

// ── WASM runtime files (fully local — no CDN) ─────────────────────────────────
const ortSrc = resolve(__dirname, 'node_modules/onnxruntime-web/dist')
const tfSrc  = resolve(__dirname, 'node_modules/@huggingface/transformers/dist')
const ortDst = resolve(__dirname, 'dist/ort')
mkdirSync(ortDst, { recursive: true })

const wasmFiles = [
  [ortSrc, 'ort-wasm-simd-threaded.wasm'],
  [ortSrc, 'ort-wasm-simd-threaded.jsep.wasm'],
  [tfSrc,  'ort-wasm-simd-threaded.jsep.mjs'],
]
for (const [src, file] of wasmFiles) {
  const full = `${src}/${file}`
  if (existsSync(full)) {
    copyFileSync(full, `${ortDst}/${file}`)
    console.log(`✓ ${file} → dist/ort/`)
  }
}

// ── Vendor: bundle transformers.js + onnxruntime-* into one self-contained ESM ─
// transformers.web.min.js uses bare specifiers (onnxruntime-common, etc.) that
// Chrome extension service workers can't resolve. We bundle all JS deps into one
// file, leaving WASM files external (loaded at runtime via wasmPaths config).
const vendorDst = resolve(__dirname, 'dist/vendor')
mkdirSync(vendorDst, { recursive: true })

await esbuild.build({
  entryPoints: [`${tfSrc}/transformers.web.min.js`],
  bundle: true,
  outfile: 'dist/vendor/transformers.bundle.js',
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  // Leave WASM/MJS runtime files external — loaded at runtime via wasmPaths
  external: ['*.wasm', '*.mjs'],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})
console.log('✓ transformers bundle → dist/vendor/transformers.bundle.js')

// ── esbuild plugin: redirect @huggingface/transformers to local bundle ─────────
const redirectTransformers = {
  name: 'redirect-transformers',
  setup(build) {
    build.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({
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
