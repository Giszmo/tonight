// A throwaway in-memory nostr relay, just enough of NIP-01 to drive the page in
// a browser without touching public relays.
import { WebSocketServer } from 'ws'

export function startRelay(port = 0) {
  const events = []
  const wss = new WebSocketServer({ port })
  const subs = new Map()

  const matches = (f, ev) => {
    if (f.kinds && !f.kinds.includes(ev.kind)) return false
    if (f.authors && !f.authors.includes(ev.pubkey)) return false
    if (f.ids && !f.ids.includes(ev.id)) return false
    if (f.since && ev.created_at < f.since) return false
    if (f.until && ev.created_at > f.until) return false
    for (const [k, vals] of Object.entries(f)) {
      if (!k.startsWith('#')) continue
      const name = k.slice(1)
      const have = ev.tags.filter(t => t[0] === name).map(t => t[1])
      if (!have.some(v => vals.includes(v))) return false
    }
    return true
  }

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      const [type, ...rest] = msg
      if (type === 'REQ') {
        const [subId, ...filters] = rest
        subs.set(subId, { ws, filters })
        for (const ev of events) {
          if (filters.some(f => matches(f, ev))) ws.send(JSON.stringify(['EVENT', subId, ev]))
        }
        ws.send(JSON.stringify(['EOSE', subId]))
      } else if (type === 'EVENT') {
        const ev = rest[0]
        events.push(ev)
        ws.send(JSON.stringify(['OK', ev.id, true, '']))
        for (const [subId, sub] of subs) {
          if (sub.filters.some(f => matches(f, ev))) {
            try { sub.ws.send(JSON.stringify(['EVENT', subId, ev])) } catch { /* client gone */ }
          }
        }
      } else if (type === 'CLOSE') {
        subs.delete(rest[0])
      }
    })
  })

  return new Promise(resolve => wss.on('listening', () => resolve({
    url: 'ws://127.0.0.1:' + wss.address().port,
    events,
    add: (ev) => events.push(ev),
    close: () => wss.close(),
  })))
}
