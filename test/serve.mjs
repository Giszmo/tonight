import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }

export function serveSite(dir, port = 0) {
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0])
    const file = path === '/' ? '/index.html' : path
    try {
      const body = await readFile(join(dir, file))
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end(await readFile(join(dir, '404.html')).catch(() => 'not found'))
    }
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () =>
    resolve({ url: 'http://127.0.0.1:' + server.address().port, close: () => server.close() })))
}
