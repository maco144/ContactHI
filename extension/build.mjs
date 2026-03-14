import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

const entries = [
  // Service worker — IIFE is fine since esbuild bundles all imports
  { entryPoints: ['src/background/service-worker.ts'], outfile: 'dist/background.js' },
  { entryPoints: ['src/content/gmail.ts'], outfile: 'dist/content-gmail.js' },
  { entryPoints: ['src/content/general.ts'], outfile: 'dist/content-general.js' },
  { entryPoints: ['src/popup/popup.ts'], outfile: 'dist/popup.js' },
  { entryPoints: ['src/options/options.ts'], outfile: 'dist/options.js' },
]

const shared = {
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: /** @type {const} */ ('iife'),
}

if (watch) {
  const contexts = await Promise.all(
    entries.map((e) => esbuild.context({ ...shared, ...e })),
  )
  await Promise.all(contexts.map((ctx) => ctx.watch()))
  console.log('Watching for changes…')
} else {
  await Promise.all(entries.map((e) => esbuild.build({ ...shared, ...e })))
  console.log('✓ Build complete →', entries.map((e) => e.outfile).join(', '))
}
