import { build } from 'esbuild'
import { cpSync } from 'node:fs'

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: process.argv.includes('--minify'),
  sourcemap: !process.argv.includes('--minify'),
  outfile: 'site/app.js',
})
cpSync('site/index.html', 'site/404.html')   // nsite gateways serve /404.html as the SPA fallback
console.log('built site/app.js')
