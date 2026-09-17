// On-demand scouting, paid by whoever asks for it.
//
// A run is not one search. A city's events live in catalogues - the city
// magazine, the town portal, the ticket platforms, the big venues' own
// calendars - and one web search returns the handful of events that happened to
// rank. So a run is two stages: find the catalogues once, then walk them until
// the time window is covered or the visitor's budget is spent. Everything the
// city already has on the relays is fed in as "we have these" and filtered out
// again on the way back, so a second run costs its money on what is missing.
//
// Walking a catalogue means fetching its pages and handing the model their text
// (see reader.js). Asking a search-backed model to walk a listing does not
// work - it never opens the page - and that, not the budget, was why a Munich
// run came back with one event from a portal that had forty-four that day.
import { InsufficientBalance } from './ppq.js'
import { dedupId, buildEventTags, sameEvent, KIND_TIME_EVENT, KIND_SCOUT_RUN } from './events.js'
import { encodeGeohash, geohashPrefixes, slugify, geocodePlace } from './geo.js'
import { readPage, sameHost, absolute } from './reader.js'

export const MAX_PER_CALL = 60          // events we ask for in one harvest call
export const MAX_PAGES_PER_SOURCE = 4   // pages of one listing we follow
export const MAX_DRILL = 6              // listing pages we follow off one hub
export const CONCURRENCY = 3            // catalogues read at the same time
export const FALLBACK_CALL_COST = 0.02  // used only until a run has measured one

const EVENT_SHAPE = `{"title":"","start":"YYYY-MM-DDTHH:MM","end":"YYYY-MM-DDTHH:MM or null","venue":"","address":"","category":"concert|theatre|opera|cinema|club|exhibition|market|talk|sports|family|other","summary":"one or two sentences in the local language","url":"https://page-for-this-event"}`

// Extraction from a page we supply must not wander off into the model's memory
// of the city; that is how invented events get published.
const EXTRACT_SYSTEM = 'You extract public events from the page text you are given. ' +
  'Report only events that are written in that text. Never invent an event, a date or a venue, ' +
  'and never add one from your own knowledge. Answer with JSON only, no prose, no code fence.'

const SYSTEM = 'You are an events scout. You search the web and report only real, specific, verifiable public events. ' +
  'Never invent an event, a date or a venue. Every event must carry the URL of the page you found it on. ' +
  'Answer with JSON only, no prose, no code fence.'

// Everything we send is stated in UTC; everything we get back is the city's
// wall clock plus the zone it belongs to. Guessing the zone from the visitor's
// browser only works while the visitor is in the city they are looking at, and
// the whole point is to look at cities you are not in yet.
const fmtStamp = (ts) => new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

export function validZone(tz) {
  if (!tz || typeof tz !== 'string') return null
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz } catch { return null }
}

// Offset of a zone at a given instant, from the only zone database a browser
// ships: Intl.
function zoneOffsetMs(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(p => [p.type, p.value]))
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second)
  return asUtc - date.getTime()
}

// "2026-09-20T20:00" in Europe/Berlin -> unix seconds. Two passes so an event
// on a DST switch lands on the right side of it.
export function zonedToSeconds(stamp, tz) {
  const naive = Date.parse(String(stamp).replace(' ', 'T') + 'Z')
  if (Number.isNaN(naive)) return null
  let ms = naive - zoneOffsetMs(new Date(naive), tz)
  ms = naive - zoneOffsetMs(new Date(ms), tz)
  return Math.floor(ms / 1000)
}

// ---------- stage 1: which catalogues cover this city ----------

export function buildSourceMessages({ city, country, exclude = [] }) {
  const where = `${city}${country ? ', ' + country : ''}`
  const known = exclude.map(s => hostOf(s.url || s)).filter(Boolean)
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        `List the web pages that catalogue public events in ${where}.\n` +
        (known.length ? `We already know these and do not want them again: ${known.join(', ')}. Find others.\n` : '') +
        'Look for: the local what-is-on magazine or city guide, the municipality\'s own events calendar, ' +
        'regional ticket platforms, the programme pages of the largest venues (concert halls, theatres, clubs), ' +
        'and university or church calendars if they are public.\n' +
        // A city portal's calendar carries concerts and theatre and no films at
        // all, so cinema has to be asked for by name or a night out at the
        // movies is simply missing from the city.
        'Cinema is listed separately from everything else: include the page that shows the daily film showtimes ' +
        'for this city (the local cinema programme, the arthouse cinemas\' own schedules, the multiplex chains).\n' +
        'Give the URL of the page that actually shows the list of dated events - a "today", "this week" or ' +
        'calendar view - not the section front page or the site homepage. A page that only links to other ' +
        'listings is worth half as much as the listing itself.\n' +
        'Only pages you have actually seen in the search results; no guessed URLs.\n' +
        'Return JSON:\n' +
        '{"sources":[{"name":"","url":"https://…","kind":"magazine|city|tickets|venue|university|other","covers":"what it lists, one line"}]}\n' +
        'Up to 10, most comprehensive first.',
    },
  ]
}

export function parseSources(text) {
  const data = parseJson(text)
  const list = Array.isArray(data) ? data : (data.sources || data.catalogues || [])
  const seen = new Set()
  return list
    .map(s => ({
      name: String(s?.name || '').trim().slice(0, 80),
      url: typeof s?.url === 'string' && /^https?:\/\//.test(s.url) ? s.url.trim() : '',
      kind: String(s?.kind || 'other').trim().toLowerCase(),
      covers: String(s?.covers || '').trim().slice(0, 160),
    }))
    .filter(s => {
      if (!s.url) return false
      const host = hostOf(s.url)
      if (!host || seen.has(host)) return false
      seen.add(host)
      return true
    })
}

// ---------- stage 2: walk one catalogue ----------

// Two shapes of the same question. When we managed to fetch the page, the page
// is the only source allowed and the call is a pure extraction - no web search,
// so it is cheaper as well as far more complete. When the fetch failed, or for
// the open-web pass that catches what no catalogue lists, we fall back to the
// search-backed form.
export function buildHarvestMessages({
  city, country, from, to, source, known = [], page = 1, after = null, pageText = null, url = null,
}) {
  const where = `${city}${country ? ', ' + country : ''}`
  const shape =
    `Return up to ${MAX_PER_CALL} events as JSON in exactly this shape:\n` +
    `{"tz":"IANA timezone of ${city}","events":[${EVENT_SHAPE}],` +
    '"listing_urls":[],"next_url":"","more":true|false,"covered_until":"YYYY-MM-DDTHH:MM"}\n' +
    `Times in "start", "end" and "covered_until" are ${city}'s own wall clock, and "tz" says which zone that is ` +
    '(for example "Europe/Berlin"). Omit any event whose date or venue you are not sure about.'
  const skip = known.length ? `Already published, skip these (times in UTC):\n${knownBlock(known)}\n` : ''
  const oneEntry = 'One entry per event date: a run of performances on five evenings is five entries.\n'

  const content = pageText
    ? `Extract every public event in ${where} that starts between ${fmtStamp(from)} and ${fmtStamp(to)} ` +
      `from the page below. It was fetched from ${url} moments ago.\n` +
      'Use only what is in the page. Do not search, do not recall, do not add anything that is not written there. ' +
      'Event URLs must be links that appear in the page.\n' +
      oneEntry +
      'If this page is an index or hub that links to listings instead of listing events itself, return no events ' +
      'and put the URLs of its actual listing pages (a today/this week/calendar view, or per-category calendars) ' +
      'into "listing_urls".\n' +
      'If the listing is paginated and continues, put the URL of the next page into "next_url".\n' +
      skip + shape +
      `\n\n--- page text of ${url} ---\n${pageText}\n--- end of page ---`
    : `Extract every public event in ${where} that starts between ${fmtStamp(from)} and ${fmtStamp(to)} from ` +
      (source?.url
        ? `the events catalogue at ${source.url}${source.name ? ` (${source.name})` : ''}`
        : `event listings for ${where} anywhere on the web`) + '.\n' +
      (page > 1
        ? `This is pass ${page}. You already reported everything up to ${after ? fmtStamp(after) : 'the start of the window'}; continue after that point and do not repeat what you already sent.\n`
        : '') +
      oneEntry + skip + shape +
      '\n"more" is true if there are events in the window you could not fit into this answer.'

  return [
    { role: 'system', content: pageText ? EXTRACT_SYSTEM : SYSTEM },
    { role: 'user', content },
  ]
}

// The known list is the expensive part of the prompt, so it is compact and
// capped; the real guarantee is the client-side filter on the way back.
function knownBlock(known, max = 150) {
  return known.slice(0, max)
    .map(e => `- ${fmtStamp(e.start)} ${e.title}${e.venue ? ' @ ' + e.venue : ''}`)
    .join('\n')
}

export function parseHarvest(text, { tz = null, base = null } = {}) {
  const data = parseJson(text)
  const obj = Array.isArray(data) ? {} : data
  const list = Array.isArray(data) ? data : (obj.events || [])
  const zone = validZone(obj.tz) || validZone(tz)
  const link = (u) => {
    const abs = typeof u === 'string' ? (base ? absolute(u, base) : u) : ''
    return /^https?:\/\//.test(abs) && (!base || sameHost(abs, base)) ? abs : ''
  }
  return {
    tz: zone,
    candidates: list.map(raw => normalizeCandidate(raw, zone)).filter(c => c && c.title && c.start),
    more: !!obj.more,
    coveredUntil: toSeconds(obj.covered_until, zone),
    // Only links on the same host: a hub's "listings" often include ad targets,
    // and following those spends the visitor's money on a ticket shop's banner.
    listingUrls: (Array.isArray(obj.listing_urls) ? obj.listing_urls : []).map(link).filter(Boolean).slice(0, 8),
    nextUrl: link(obj.next_url),
  }
}

export function parseCandidates(text, opts) {
  return parseHarvest(text, opts).candidates
}

function parseJson(text) {
  const cleaned = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const m = cleaned.match(/[[{][\s\S]*[\]}]/)
    if (!m) throw new Error('model did not return JSON')
    return JSON.parse(m[0])
  }
}

function normalizeCandidate(raw, tz = null) {
  if (!raw || typeof raw !== 'object') return null
  const start = toSeconds(raw.start, tz)
  if (!start) return null
  const end = toSeconds(raw.end, tz)
  const url = typeof raw.url === 'string' && /^https?:\/\//.test(raw.url) ? raw.url : ''
  return {
    title: String(raw.title || '').trim().slice(0, 200),
    start,
    end: end && end > start ? end : null,
    venue: String(raw.venue || '').trim().slice(0, 120),
    address: String(raw.address || '').trim().slice(0, 200),
    category: String(raw.category || 'other').trim().toLowerCase(),
    summary: String(raw.summary || '').trim().slice(0, 400),
    url,
    lat: Number.isFinite(raw.lat) ? raw.lat : null,
    lon: Number.isFinite(raw.lon) ? raw.lon : null,
  }
}

// A bare "2026-09-20T20:00" is the city's wall clock: read it in the city's
// zone when the model named one, and fall back to the browser's zone otherwise.
function toSeconds(v, tz = null) {
  if (!v) return null
  if (typeof v === 'number') return Math.floor(v)
  if (/^\d{10}$/.test(v)) return parseInt(v, 10)
  if (/Z|[+-]\d{2}:?\d{2}$/.test(v)) {
    const ms = Date.parse(v)
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
  }
  if (tz) return zonedToSeconds(v, tz)
  const ms = Date.parse(String(v).replace(' ', 'T'))
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

// A run now visits several pages of the same host, so the host alone stops
// telling the visitor which page a batch of events came from.
const visitKey = (job) => `${String(job.url || '').replace(/#.*$/, '')}|${job.page}`

export function shortUrl(url, max = 38) {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/$/, '')
    const full = u.hostname.replace(/^www\./, '') + path + (u.search ? u.search : '')
    return full.length > max ? full.slice(0, max - 1) + '…' : full
  } catch { return String(url || '') }
}

// ---------- dedup against what the city already has ----------

// sameEvent() works on parsed nostr events; a candidate is close enough once it
// is given the same field names.
export function candidateShape(c) {
  return {
    id: '', d: '', address: '',
    title: c.title, venue: c.venue || '', start: c.start, end: c.end || null,
    coords: Number.isFinite(c.lat) && Number.isFinite(c.lon) ? { lat: c.lat, lon: c.lon } : null,
    refs: c.url ? [c.url] : [], image: '', summary: c.summary || '', createdAt: 0, hashtags: [],
  }
}

export function findDuplicate(candidate, list) {
  const shape = candidateShape(candidate)
  return list.find(e => sameEvent(shape, e)) || null
}

// ---------- the run ----------

// One run: measure the balance around every call, so the cost reported to the
// next visitor is what was actually charged, and stop before the next call would
// cross the budget the visitor set.
export async function runScout(acc, {
  city, country, lat, lon, from, to,
  known = [], model, budgetUsd = 0.25, sources = null, discover = 'auto', maxCalls = 30,
  api, onProgress = () => {}, shouldStop = () => false, fetchPage = readPage,
}) {
  if (!api) throw new Error('runScout needs a PPQ api')
  const startedAt = Math.floor(Date.now() / 1000)
  let balance = await api.getBalance(acc)
  if (!(balance > 0)) throw new InsufficientBalance()

  const budget = Math.min(budgetUsd, balance)
  const startBalance = balance
  const calls = []
  const accepted = []
  const knownShapes = known.slice()
  let spent = 0
  let reserved = 0     // estimated cost of the calls currently in flight
  let inflight = 0
  let modelUsed = model || ''
  let cityZone = null
  let stoppedBecause = 'window covered'

  const estimate = () => (calls.length ? Math.max(...calls.map(c => c.costUsd), 0.001) : FALLBACK_CALL_COST)
  // Under concurrency the budget has to be reserved before a call, not counted
  // after it: three calls that each fit on their own must not all start when
  // only two fit together.
  const affordable = () => balance > 0 &&
    spent + reserved + estimate() <= budget + 1e-9 &&
    calls.length + inflight < maxCalls
  const progress = (extra = {}) => onProgress({
    spent, budget, balance, calls: calls.slice(), found: accepted.length, ...extra,
  })

  // Several calls in flight cannot each be priced from a balance delta, but the
  // total can: the balance is absolute, so startBalance - balance is what the
  // account has really been charged no matter how many calls are open. That
  // figure is read after every call, because the budget check is only as good
  // as the last reading, and the per-call numbers are the batch's share of it.
  async function settle() {
    const before = spent
    try { balance = await api.getBalance(acc) } catch { return }
    spent = Math.max(0, +(startBalance - balance).toFixed(5))
    const open = calls.filter(c => c.estimated)
    const share = open.length ? Math.max(0, +((spent - before) / open.length).toFixed(5)) : 0
    for (const c of open) { c.costUsd = share; c.estimated = false }
  }

  // The claim is held for a whole job, not just for the call inside it: a job
  // spends a second or two fetching its page before it spends any money, and
  // three workers that check the budget during each other's fetches would all
  // decide they fit.
  async function withClaim(fn) {
    const est = estimate()
    reserved = +(reserved + est).toFixed(5)
    inflight++
    try {
      return await fn()
    } finally {
      reserved = +(reserved - est).toFixed(5)
      inflight--
    }
  }

  async function paidCall(label, messages, maxTokens, opts = {}) {
    const entry = { label, costUsd: estimate(), estimated: true }
    calls.push(entry)
    try {
      const res = await api.chat(acc, { model, messages, maxTokens, ...opts })
      modelUsed = res.model || modelUsed
      return [res, entry]
    } catch (err) {
      entry.failed = true
      throw err
    } finally {
      await settle()
    }
  }

  // stage 1: the catalogues. The registry on the relays is the default answer -
  // somebody already paid for this question - and a run only pays for the
  // search again when there is nothing known, or when it is asked to look for
  // catalogues beyond the ones the registry already holds.
  const fromRegistry = Array.isArray(sources) ? sources.filter(s => s?.url) : []
  const wantDiscovery = discover === 'always' || (discover !== 'never' && !fromRegistry.length)
  let usedSources = fromRegistry.slice()
  let discovered = []
  if (wantDiscovery) {
    progress({ phase: 'sources', label: fromRegistry.length
      ? `looking for catalogues beyond the ${fromRegistry.length} we know`
      : 'looking for the catalogues that cover ' + city })
    try {
      const [res] = await withClaim(() => paidCall('catalogues', buildSourceMessages({ city, country, exclude: fromRegistry }), 2000))
      const knownHosts = new Set(fromRegistry.map(s => hostOf(s.url)))
      discovered = parseSources(res.text).filter(s => !knownHosts.has(hostOf(s.url))).slice(0, 10)
      usedSources = [...discovered, ...fromRegistry]
    } catch (err) {
      if (err instanceof InsufficientBalance) throw err
      console.warn('source discovery failed, falling back to what we have', err)
    }
    progress({
      phase: 'sources',
      label: discovered.length
        ? `${discovered.length} new ${discovered.length === 1 ? 'catalogue' : 'catalogues'}: ${discovered.map(s => hostOf(s.url)).join(', ')}`
        : 'no catalogues we did not already know',
      sources: usedSources.slice(),
    })
  }

  // stage 2: walk them, then one open-web pass to catch what no catalogue lists.
  // Fetching a page is free, so the visitor's money goes into extraction only -
  // a run with ten cents in it still reads whole listings.
  const queue = usedSources.map(s => ({ source: s, url: s.url || '', page: 1, after: null, depth: 0 }))
  const OPEN_WEB = { name: 'open web search', url: '', kind: 'search' }

  const visited = new Set()
  const productive = new Map()   // pages that actually yielded events, for the registry
  let openWebRan = false

  async function runJob(job) {
    // Keyed by page as well as URL: a second pass over the same listing is a
    // different question ("continue after X"), a second visit to the same first
    // page is not.
    if (job.url) {
      if (visited.has(visitKey(job))) return
      visited.add(visitKey(job))
    }
    const label = job.url ? shortUrl(job.url) : 'open web'
    const id = `${label}|${job.page}`

    // Read the page ourselves. A model with a web search attached never opens
    // the listing; it answers from snippets, which is one or two events for a
    // page that holds forty.
    let pageText = null
    if (job.url) {
      progress({ id, phase: 'fetch', label: `fetching ${label}` })
      try {
        pageText = await fetchPage(job.url)
      } catch (err) {
        progress({ id, phase: 'fetch', label: `${label} would not load, asking the web instead` })
      }
    }

    progress({ id, phase: 'harvest', label: `reading ${label}${job.page > 1 ? ` (page ${job.page})` : ''}` })
    let harvest, entry
    try {
      const [res, call] = await paidCall(label, buildHarvestMessages({
        city, country, from, to, source: job.source, page: job.page, after: job.after,
        pageText, url: job.url || null,
        known: [...knownShapes, ...accepted.map(candidateShape)],
      }), 8000, { search: !pageText })
      entry = call
      harvest = parseHarvest(res.text, { tz: cityZone, base: pageText ? job.url : null })
      if (harvest.tz) cityZone = harvest.tz
    } catch (err) {
      if (err instanceof InsufficientBalance) { stoppedBecause = 'out of credit'; throw err }
      console.warn('harvest failed for ' + label, err)
      if (entry) entry.failed = true
      progress({ id, phase: 'harvest', label: `${label}: no usable answer` })
      return
    }

    // An hour of slack for listings that round, no more: the window is what the
    // visitor asked for and is paying for.
    const inWindow = harvest.candidates.filter(c => c.start >= from - 3600 && c.start <= to + 3600)
    let added = 0
    for (const c of inWindow) {
      if (findDuplicate(c, knownShapes)) continue
      if (findDuplicate(c, accepted.map(candidateShape))) continue
      accepted.push({ ...c, source: label })
      added++
    }
    if (entry) { entry.found = inWindow.length; entry.added = added }

    // A hub - the section front page most catalogues advertise - lists no
    // events itself. It names the pages that do, and those are what the next
    // visitor should find in the registry, so they are followed now and
    // published later.
    if (harvest.listingUrls.length && !inWindow.length && job.depth < 1) {
      const next = harvest.listingUrls.filter(u => !visited.has(visitKey({ url: u, page: 1 }))).slice(0, MAX_DRILL)
      queue.unshift(...next.map(u => ({
        source: { ...job.source, url: u, name: job.source?.name || hostOf(u) },
        url: u, page: 1, after: null, depth: job.depth + 1,
      })))
      progress({ id, phase: 'harvest', label: next.length
        ? `${label} is an index, following ${next.length} ${next.length === 1 ? 'listing' : 'listings'} it points at`
        : `${label}: nothing to follow` })
      return
    }

    progress({ id, phase: 'harvest', label: `${label}: ${inWindow.length} events, ${added} new` })
    if (added > 0 && job.url) {
      productive.set(job.url, {
        url: job.url,
        name: job.source?.name || hostOf(job.url),
        kind: job.source?.kind || 'other',
        covers: job.source?.covers || `${inWindow.length} events in one listing`,
      })
    }

    // Next page of the same listing, as long as this one paid off.
    if (job.page < MAX_PAGES_PER_SOURCE && added > 0) {
      if (harvest.nextUrl && !visited.has(visitKey({ url: harvest.nextUrl, page: job.page + 1 }))) {
        queue.push({ source: job.source, url: harvest.nextUrl, page: job.page + 1, after: null, depth: job.depth })
      } else if (harvest.more && !pageText) {
        const after = harvest.coveredUntil || inWindow.reduce((m, c) => Math.max(m, c.start), job.after || from)
        queue.push({ source: job.source, url: job.url, page: job.page + 1, after, depth: job.depth })
      }
    }
  }

  // Catalogues are independent of each other, so they are read at the same
  // time; the visitor watches one list fill instead of waiting out ten round
  // trips end to end. The budget is what bounds a run, and it is reserved
  // before a call starts, so widening this cannot overspend it.
  async function drain(width) {
    await Promise.all(Array.from({ length: width }, async () => {
      while (queue.length && affordable() && !shouldStop()) {
        const job = queue.shift()
        if (!job) return
        try { await withClaim(() => runJob(job)) } catch (err) {
          if (err instanceof InsufficientBalance) return
          throw err
        }
      }
    }))
  }

  await drain(CONCURRENCY)

  // The open web is the weakest pass and it runs alone at the end, so it gets
  // the money the catalogues left rather than money they needed.
  if (queue.length === 0 && affordable() && !shouldStop()) {
    openWebRan = true
    queue.push({ source: OPEN_WEB, url: '', page: 1, after: null, depth: 0 })
    await drain(1)
  }

  if (shouldStop()) stoppedBecause = 'stopped by you'
  else if (!(balance > 0)) stoppedBecause = 'out of credit'
  else if (calls.length >= maxCalls) stoppedBecause = 'call limit reached'
  else if (queue.length || !openWebRan) stoppedBecause = 'budget spent'

  accepted.sort((a, b) => a.start - b.start)
  progress({ phase: 'done', label: stoppedBecause })
  return {
    candidates: accepted,
    costUsd: +spent.toFixed(4),
    balance,
    budgetUsd: budget,
    model: modelUsed,
    calls,
    sources: usedSources,
    discovered,
    productive: [...productive.values()],
    stoppedBecause,
    tz: cityZone,
    startedAt,
    window: { from, to },
    city,
    lat,
    lon,
  }
}

// ---------- candidate -> signed event ----------

// Geocoding is a courtesy call to a free public service, so a run that found 90
// events must not fire 90 requests: unique venues only, memoised, capped.
export function makeGeocoder({ enabled = true, limit = 50, lookup = geocodePlace } = {}) {
  const memo = new Map()
  let used = 0
  return async function geocode(venue, city) {
    if (!enabled || !venue) return null
    const key = `${venue}|${city}`.toLowerCase()
    if (memo.has(key)) return memo.get(key)
    if (used >= limit) return null
    used++
    let hit = null
    try { hit = await lookup(`${venue}, ${city}`) } catch { /* city centre it is */ }
    memo.set(key, hit)
    return hit
  }
}

export async function candidateToEvent(identity, candidate, { city, lat, lon, tz = null, geocode = null }) {
  let place = null
  if (Number.isFinite(candidate.lat) && Number.isFinite(candidate.lon)) place = { lat: candidate.lat, lon: candidate.lon }
  else if (geocode) place = await geocode(candidate.venue, city)
  const coords = place || { lat, lon }
  const d = await dedupId({ title: candidate.title, venue: candidate.venue, start: candidate.start })
  return identity.sign({
    kind: KIND_TIME_EVENT,
    created_at: Math.floor(Date.now() / 1000),
    content: candidate.summary || '',
    tags: buildEventTags({
      d,
      title: candidate.title,
      summary: candidate.summary,
      start: candidate.start,
      end: candidate.end,
      venue: candidate.venue,
      address: candidate.address,
      lat: coords.lat,
      lon: coords.lon,
      city,
      category: candidate.category,
      url: candidate.url,
      tzid: tz,
    }),
  })
}

export async function scoutRunEvent(identity, run, publishedCount) {
  const tags = [
    ['t', slugify(run.city)],
    ['found', String(run.candidates.length)],
    ['published', String(publishedCount)],
    ['cost_usd', run.costUsd.toFixed(4)],
    ['budget_usd', Number(run.budgetUsd || 0).toFixed(2)],
    ['calls', String(run.calls?.length || 1)],
    ['sources', String(run.sources?.length || 0)],
    ['model', run.model],
    ['window', String(run.window.from), String(run.window.to)],
    ['alt', `scout run for ${run.city}`],
  ]
  if (Number.isFinite(run.lat) && Number.isFinite(run.lon)) {
    for (const g of geohashPrefixes(encodeGeohash(run.lat, run.lon, 5), 2, 5)) tags.push(['g', g])
  }
  return identity.sign({
    kind: KIND_SCOUT_RUN,
    created_at: Math.floor(Date.now() / 1000),
    content: `Scouted ${run.city}: ${run.calls?.length || 1} calls over ${run.sources?.length || 0} catalogues, ` +
      `${run.candidates.length} new candidates, ${publishedCount} published, $${run.costUsd.toFixed(3)} of inference.`,
    tags,
  })
}
