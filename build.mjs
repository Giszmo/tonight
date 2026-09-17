import { build } from 'esbuild'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

// Everything is inlined into index.html on purpose. nsite gateways guess the
// content type of a blob, and a gateway that answers application/octet-stream
// for app.js gets the module rejected by strict MIME checking - the page then
// silently does nothing. One HTML file is served as text/html everywhere.
const out = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  write: false,
  outfile: 'app.js',
})

const js = out.outputFiles[0].text
const css = readFileSync('src/style.css', 'utf8')
const html = readFileSync('src/index.html', 'utf8')
  .replace('/*__STYLE__*/', () => css)
  .replace('/*__APP__*/', () => js)

writeFileSync('site/index.html', html)
writeFileSync('site/404.html', html)   // nsite gateways serve /404.html as the SPA fallback
rmSync('site/app.js', { force: true })
rmSync('site/app.js.map', { force: true })
console.log(`built site/index.html (${(html.length / 1024).toFixed(0)} kB, css ${(css.length / 1024).toFixed(0)} kB, js ${(js.length / 1024).toFixed(0)} kB)`)
