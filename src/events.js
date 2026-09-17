// NIP-52 event model, the dedup convention, and canonical-copy selection.
import { encodeGeohash, geohashPrefixes, decodeGeohash, slugify, haversineKm } from './geo.js'

export const KIND_DATE_EVENT = 31922   // whole-day event (NIP-52)
export const KIND_TIME_EVENT = 31923   // time-based event (NIP-52)
export const KIND_CALENDAR = 31924
export const KIND_RSVP = 31925
export const KIND_REACTION = 7
export const KIND_SCOUT_RUN = 2121     // provisional, app-specific: see DESIGN.md
export const KIND_SOURCE = 31121       // provisional, app-specific: a catalogue worth scouting

export const tagValues = (ev, name) => (ev.tags || []).filter(t => t[0] === name).map(t => t[1])
export const tagValue = (ev, name) => tagValues(ev, name)[0]

export function eventAddress(ev) {
  return `${ev.kind}:${ev.pubkey}:${tagValue(ev, 'd') || ''}`
}

// Start/end are unix seconds for 31923 and YYYY-MM-DD for 31922.
export function startSeconds(ev) {
  const raw = tagValue(ev, 'start')
  if (!raw) return null
  if (/^\d+$/.test(raw)) return parseInt(raw, 10)
  const d = Date.parse(raw + 'T00:00:00')
  return Number.isNaN(d) ? null : Math.floor(d / 1000)
}

export function endSeconds(ev) {
  const raw = tagValue(ev, 'end')
  if (!raw) return null
  if (/^\d+$/.test(raw)) return parseInt(raw, 10)
  const d = Date.parse(raw + 'T23:59:59')
  return Number.isNaN(d) ? null : Math.floor(d / 1000)
}

export function eventCoords(ev) {
  const hashes = tagValues(ev, 'g').filter(Boolean)
  if (!hashes.length) return null
  // longest geohash = most precise
  const best = hashes.slice().sort((a, b) => b.length - a.length)[0]
  return decodeGeohash(best)
}

// German transliteration first: an umlaut spelling and its "ae/oe/ue" form
// have to fold together; NFD stripping alone gives "arzte" vs "aerzte".
function foldUmlauts(s) {
  return String(s || '').toLowerCase()
    .replace(/\u00e4/g, 'ae').replace(/\u00f6/g, 'oe').replace(/\u00fc/g, 'ue').replace(/\u00df/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

export function normalizeTitle(title) {
  return foldUmlauts(title)
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(die|der|das|the|a|an|le|la|el|und|and|mit|with|im|in|at|feat|featuring|live|konzert|concert|tour|presents|prasentiert)\b/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

export function normalizeVenue(venue) {
  return foldUmlauts(venue)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(theater|theatre|halle|hall|club|bar|cafe|kino|cinema|zentrum|center|centre|muenchen|munchen|munich|gmbh|e\s?v)\b/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Dedup convention: the `d` tag is derived from what makes an event the same
// event no matter who published it - normalised title, normalised venue and the
// start time rounded to the quarter hour. Two scouts that saw the same concert
// on two different sites produce the same address suffix, so clients collapse
// the copies and endorsements land on one identity.
export async function dedupId({ title, venue, start }) {
  const startQuarter = Math.round(Number(start) / 900) * 900
  const key = `${normalizeTitle(title)}|${normalizeVenue(venue)}|${startQuarter}`
  return (await sha256Hex(key)).slice(0, 32)
}

// Publishers often paste the booking link into the description. The card shows
// the source as a link already, so strip bare URLs out of the running text.
function cleanSummary(text) {
  return String(text || '').replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim()
}

export function parseEvent(ev) {
  const start = startSeconds(ev)
  const venue = tagValue(ev, 'location') || ''
  return {
    id: ev.id,
    kind: ev.kind,
    pubkey: ev.pubkey,
    d: tagValue(ev, 'd') || '',
    address: eventAddress(ev),
    title: tagValue(ev, 'title') || (ev.content || '').slice(0, 80) || 'Untitled',
    summary: cleanSummary(tagValue(ev, 'summary') || ev.content || ''),
    image: tagValue(ev, 'image') || '',
    venue,
    start,
    end: endSeconds(ev),
    allDay: ev.kind === KIND_DATE_EVENT,
    coords: eventCoords(ev),
    hashtags: tagValues(ev, 't'),
    refs: tagValues(ev, 'r'),
    createdAt: ev.created_at,
    raw: ev,
  }
}

// Group copies of the same real-world event. The `d` convention makes copies
// collapse for any client that only compares addresses; here we also cluster on
// content, so copies from scouts that used their own `d` still collapse.
export function groupCopies(parsed) {
  const sorted = parsed.slice().sort((a, b) => (a.start || 0) - (b.start || 0))
  const groups = []
  for (const e of sorted) {
    const g = groups.find(g => g.copies.some(c => sameEvent(c, e)))
    if (g) g.copies.push(e)
    else groups.push({ copies: [e] })
  }
  return groups.map(g => {
    const copies = g.copies.slice().sort(rankCopies)
    return { key: copies[0].d || copies[0].id, canonical: copies[0], copies }
  })
}

// Tags are what made an event findable, so they are also the facet worth
// clicking. A group carries the tags of every copy: the magazine's "konzert"
// and the ticket shop's "concert" both lead to the same card, and a filter on
// either one keeps it.
export function groupTags(group) {
  const out = new Set()
  for (const c of group.copies) for (const t of c.hashtags || []) {
    const slug = slugify(t)
    if (slug) out.add(slug)
  }
  return out
}

export function groupHasTag(group, tag) {
  if (!tag) return true
  return groupTags(group).has(slugify(tag))
}

const TOLERANCE_SECONDS = 1800
const TOLERANCE_KM = 0.3

export function sameEvent(a, b) {
  if (a.address && a.address === b.address) return true
  if (a.d && a.d === b.d) return true
  if (!a.start || !b.start || Math.abs(a.start - b.start) > TOLERANCE_SECONDS) return false
  const sameVenue = venueMatch(a, b)
  if (sameVenue === false) return false
  const ta = normalizeTitle(a.title), tb = normalizeTitle(b.title)
  // Same room, same half hour: two different events are implausible, so a
  // partial title overlap is enough. One publisher writes "Kammerorchester
  // Muenchen - Schubert (Prinzregententheater)", the other "Muenchner
  // Kammerorchester: Schubert"; containment catches that, Jaccard does not.
  if (sameVenue) return containment(ta, tb) >= 0.6
  // Venue unknown on at least one side: only near-identical titles collapse.
  return jaccard(ta, tb) >= 0.8
}

function containment(a, b) {
  const A = new Set(a.split(' ').filter(Boolean)), B = new Set(b.split(' ').filter(Boolean))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / Math.min(A.size, B.size)
}

function venueMatch(a, b) {
  const va = normalizeVenue(a.venue), vb = normalizeVenue(b.venue)
  if (va && vb) {
    if (va === vb || va.includes(vb) || vb.includes(va)) return true
    if (jaccard(va, vb) >= 0.5) return true
    return false
  }
  if (a.coords && b.coords) return haversineKm(a.coords, b.coords) <= TOLERANCE_KM
  return null // unknown: fall back to a stricter title match
}

function jaccard(a, b) {
  const A = new Set(a.split(' ').filter(Boolean)), B = new Set(b.split(' ').filter(Boolean))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

// Author tiers: organiser-claimed > human-signed > scout bot. v0 has no
// organiser proof yet, so rank on the signals we do have.
function rankCopies(a, b) {
  const score = e => (e.refs.length ? 1 : 0) + (e.image ? 1 : 0) + (e.summary ? 1 : 0) + (e.end ? 1 : 0)
  return score(b) - score(a) || b.createdAt - a.createdAt
}

// Tag set for a newly published event. Multi-precision `g` is what makes it
// findable by anyone else's "near me" query.
export function buildEventTags({ d, title, summary, start, end, venue, address, lat, lon, city, aliases = [], category, url, image, tzid }) {
  const tags = [
    ['d', d],
    ['title', title],
    ['start', String(start)],
  ]
  if (end) tags.push(['end', String(end)])
  tags.push(['start_tzid', tzid || Intl.DateTimeFormat().resolvedOptions().timeZone])
  if (summary) tags.push(['summary', summary])
  if (image) tags.push(['image', image])
  if (venue) tags.push(['location', address ? `${venue}, ${address}` : venue])
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    for (const g of geohashPrefixes(encodeGeohash(lat, lon, 8), 2, 8)) tags.push(['g', g])
  }
  for (const t of cityTags(city, aliases)) tags.push(['t', t])
  if (category) tags.push(['t', slugify(category)])
  if (url) tags.push(['r', url])
  tags.push(['alt', `${title} - ${venue || city || ''}`])
  return tags
}

// One city, one set of hashtags. Whoever types "Munich" and whoever types
// "Muenchen" are looking at the same place, and the geohash says so - so an
// event published under either label also carries the labels the city already
// goes by on the relays. Without that, one spelling quietly forks the city into
// two half-empty listings for anyone who reads by hashtag alone.
export function cityTags(city, aliases = []) {
  const out = []
  for (const name of [city, ...aliases]) {
    if (!name) continue
    for (const t of [slugify(name), String(name).toLowerCase()]) {
      if (t && !out.includes(t)) out.push(t)
    }
  }
  return out.slice(0, 6)
}

// A scouting source: one catalogue page that lists events for a city. Finding
// them costs a paid search, so the finder publishes them and the next visitor
// spends their money on events instead of on the same question.
export function buildSourceTags({ url, name, kind, covers, city, aliases = [], lat, lon }) {
  const tags = [
    ['d', sourceDTag(url)],
    ['r', url],
    ['title', name || sourceDTag(url)],
  ]
  if (kind) tags.push(['source_kind', kind])
  if (covers) tags.push(['summary', covers])
  for (const t of cityTags(city, aliases)) tags.push(['t', t])
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    for (const g of geohashPrefixes(encodeGeohash(lat, lon, 5), 2, 5)) tags.push(['g', g])
  }
  tags.push(['alt', `event catalogue for ${city || 'a city'}: ${url}`])
  return tags
}

export function sourceDTag(url) {
  try {
    const u = new URL(url)
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '')).slice(0, 100)
  } catch { return String(url || '').slice(0, 100) }
}

export function parseSourceEvent(ev) {
  const url = tagValue(ev, 'r') || ''
  return {
    url,
    name: tagValue(ev, 'title') || sourceDTag(url),
    kind: tagValue(ev, 'source_kind') || 'other',
    covers: tagValue(ev, 'summary') || '',
    cities: ev.tags.filter(t => t[0] === 't').map(t => t[1]).filter(Boolean),
    geohashes: ev.tags.filter(t => t[0] === 'g').map(t => t[1]).filter(Boolean),
    pubkey: ev.pubkey,
    createdAt: ev.created_at,
  }
}
