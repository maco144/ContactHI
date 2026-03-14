import * as esbuild from 'esbuild'
import { copyFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

// Copy WASM runtime files so inference runs fully on-device (no CDN needed)
const ortSrc = resolve(__dirname, 'node_modules/onnxruntime-web/dist')
const ortDst = resolve(__dirname, 'dist/ort')
mkdirSync(ortDst, { recursive: true })
for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.wasm']) {
  try {
    copyFileSync(`${ortSrc}/${f}`, `${ortDst}/${f}`)
  } catch {
    // file may not exist in all onnxruntime-web versions — skip silently
  }
}
console.log('✓ WASM runtime copied → dist/ort/')

const contentEntries = [
  { entryPoints: ['src/content/gmail.ts'], outfile: 'dist/content-gmail.js' },
  { entryPoints: ['src/content/general.ts'], outfile: 'dist/content-general.js' },
  { entryPoints: ['src/popup/popup.ts'], outfile: 'dist/popup.js' },
  { entryPoints: ['src/options/options.ts'], outfile: 'dist/options.js' },
]

const contentShared = {
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: /** @type {const} */ ('iife'),
}

// Service worker must be ESM for MV3 "type": "module" + transformers.js
const bgShared = {
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: /** @type {const} */ ('esm'),
}

if (watch) {
  const [bgCtx, ...contentCtxs] = await Promise.all([
    esbuild.context({ ...bgShared, entryPoints: ['src/background/service-worker.ts'], outfile: 'dist/background.js' }),
    ...contentEntries.map((e) => esbuild.context({ ...contentShared, ...e })),
  ])
  await Promise.all([bgCtx.watch(), ...contentCtxs.map((c) => c.watch())])
  console.log('Watching for changes…')
} else {
  await Promise.all([
    esbuild.build({ ...bgShared, entryPoints: ['src/background/service-worker.ts'], outfile: 'dist/background.js' }),
    ...contentEntries.map((e) => esbuild.build({ ...contentShared, ...e })),
  ])
  console.log('✓ Build complete')
}
