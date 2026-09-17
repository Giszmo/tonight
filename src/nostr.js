// Relay access and identity. Everything here runs in the visitor's browser;
// there is no server in this product.
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import {
  KIND_DATE_EVENT, KIND_TIME_EVENT, KIND_RSVP, KIND_REACTION, KIND_SCOUT_RUN,
  parseEvent, eventAddress,
} from './events.js'
import { geohashPrefixes, encodeGeohash, slugify } from './geo.js'

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.wine',
]

const LS = {
  guestKey: 'tonight.guestkey',
  relays: 'tonight.relays',
}

let pool = null
export function getPool() {
  if (!pool) pool = new SimplePool()
  return pool
}

export function getRelays() {
  try {
    const stored = JSON.parse(localStorage.getItem(LS.relays) || 'null')
    if (Array.isArray(stored) && stored.length) return stored
  } catch { /* fall through to defaults */ }
  return DEFAULT_RELAYS
}

export function setRelays(relays) {
  localStorage.setItem(LS.relays, JSON.stringify(relays))
  if (pool) { pool.close(getRelays()); pool = null }
}

// Identity: a NIP-07 extension if the visitor happens to have one, otherwise a
// guest key generated here. A guest key still carries reputation forward - it
// is a real nostr identity the visitor can export.
export async function getIdentity() {
  if (typeof window !== 'undefined' && window.nostr?.getPublicKey) {
    try {
      const pubkey = await window.nostr.getPublicKey()
      return {
        mode: 'nip07',
        pubkey,
        npub: nip19.npubEncode(pubkey),
        sign: (template) => window.nostr.signEvent(template),
      }
    } catch { /* extension refused - fall back to the guest key */ }
  }
  let hex = localStorage.getItem(LS.guestKey)
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
    hex = bytesToHex(generateSecretKey())
    localStorage.setItem(LS.guestKey, hex)
  }
  const sk = hexToBytes(hex)
  const pubkey = getPublicKey(sk)
  return {
    mode: 'guest',
    pubkey,
    npub: nip19.npubEncode(pubkey),
    nsec: nip19.nsecEncode(sk),
    sign: (template) => finalizeEvent(template, sk),
  }
}

export function bytesToHex(b) { return [...b].map(x => x.toString(16).padStart(2, '0')).join('') }
export function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

export async function publish(event, relays = getRelays()) {
  const results = await Promise.allSettled(getPool().publish(relays, event))
  const ok = results.filter(r => r.status === 'fulfilled').length
  if (!ok) throw new Error('no relay accepted the event: ' + results.map(r => r.reason?.message || r.reason).join('; '))
  return { accepted: ok, of: relays.length }
}

async function query(filter, { relays = getRelays(), timeout = 6000 } = {}) {
  try {
    return await getPool().querySync(relays, filter, { maxWait: timeout })
  } catch (err) {
    console.warn('query failed', filter, err)
    return []
  }
}

// "Near me" is several exact-match geohash filters plus the city hashtag, plus
// a broad recent sweep. The sweep is affordable while the global NIP-52 volume
// is small and it catches publishers who tag neither.
export async function fetchCityEvents({ lat, lon, city, from, to, radiusKm = 30, broadSweep = true }) {
  const centre = encodeGeohash(lat, lon, 8)
  // ~20-40 km cells are precision 4; ask 3..5 so both coarse and fine taggers hit.
  const hashes = geohashPrefixes(centre, 3, 5)
  const tags = [slugify(city), String(city || '').toLowerCase()].filter((v, i, a) => v && a.indexOf(v) === i)
  const kinds = [KIND_TIME_EVENT, KIND_DATE_EVENT]
  const filters = [
    { kinds, '#g': hashes, limit: 500 },
    { kinds, '#t': tags, limit: 500 },
  ]
  if (broadSweep) filters.push({ kinds, limit: 500, since: Math.floor(Date.now() / 1000) - 120 * 86400 })
  const batches = await Promise.all(filters.map(f => query(f)))
  const byId = new Map()
  for (const batch of batches) for (const ev of batch) byId.set(ev.id, ev)
  return [...byId.values()].map(parseEvent).filter(e => inWindow(e, from, to))
}

function inWindow(e, from, to) {
  if (!e.start) return false
  const end = e.end || e.start + 3 * 3600
  return end >= from && e.start <= to
}

export async function fetchEndorsements(addresses) {
  if (!addresses.length) return new Map()
  const out = new Map()
  for (let i = 0; i < addresses.length; i += 50) {
    const slice = addresses.slice(i, i + 50)
    const evs = await query({ kinds: [KIND_REACTION, KIND_RSVP], '#a': slice, limit: 1000 })
    for (const ev of evs) {
      const a = (ev.tags.find(t => t[0] === 'a') || [])[1]
      if (!a) continue
      const rec = out.get(a) || { going: new Set(), likes: new Set() }
      if (ev.kind === KIND_RSVP) {
        const status = (ev.tags.find(t => t[0] === 'status') || [])[1]
        if (status === 'accepted' || status === 'tentative') rec.going.add(ev.pubkey)
      } else if (ev.content !== '-') {
        rec.likes.add(ev.pubkey)
      }
      out.set(a, rec)
    }
  }
  return out
}

export async function fetchFollows(pubkey) {
  if (!pubkey) return new Set()
  const evs = await query({ kinds: [3], authors: [pubkey], limit: 1 })
  const latest = evs.sort((a, b) => b.created_at - a.created_at)[0]
  if (!latest) return new Set()
  return new Set(latest.tags.filter(t => t[0] === 'p').map(t => t[1]))
}

export async function fetchScoutRuns(city) {
  const tags = [slugify(city), String(city || '').toLowerCase()].filter((v, i, a) => v && a.indexOf(v) === i)
  const evs = await query({ kinds: [KIND_SCOUT_RUN], '#t': tags, limit: 100 })
  return evs
    .map(ev => ({
      pubkey: ev.pubkey,
      at: ev.created_at,
      found: num(ev, 'found'),
      published: num(ev, 'published'),
      costUsd: parseFloat((ev.tags.find(t => t[0] === 'cost_usd') || [])[1] || 'NaN'),
      model: (ev.tags.find(t => t[0] === 'model') || [])[1] || '',
      summary: ev.content,
    }))
    .sort((a, b) => b.at - a.at)
}

const num = (ev, name) => parseInt((ev.tags.find(t => t[0] === name) || [])[1] || '0', 10)

export async function publishRsvp(identity, target, { status = 'accepted', alsoReact = true } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const address = eventAddress(target.raw)
  const rsvp = await identity.sign({
    kind: KIND_RSVP,
    created_at: now,
    content: '',
    tags: [
      ['d', crypto.randomUUID()],
      ['a', address],
      ['e', target.id],
      ['p', target.pubkey],
      ['status', status],
    ],
  })
  const out = [await publish(rsvp)]
  if (alsoReact) {
    const reaction = await identity.sign({
      kind: KIND_REACTION,
      created_at: now,
      content: '+',
      tags: [['a', address], ['e', target.id], ['p', target.pubkey], ['k', String(target.kind)]],
    })
    out.push(await publish(reaction))
  }
  return out
}

export { eventAddress }
