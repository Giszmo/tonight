// On-demand scouting: one paid model call with web search, a reviewed list of
// candidates, then nostr events signed by the visitor. No cron, no scraper of
// ours; the person who wants fresher data pays for it and everyone else reads
// the result off the relays for free.
import { chat, getBalance, InsufficientBalance } from './ppq.js'
import { dedupId, buildEventTags, KIND_TIME_EVENT, KIND_SCOUT_RUN } from './events.js'
import { encodeGeohash, geohashPrefixes, slugify, geocodePlace } from './geo.js'

const SCHEMA_HINT = `{"events":[{"title":"","start":"YYYY-MM-DDTHH:MM","end":"YYYY-MM-DDTHH:MM or null","venue":"","address":"","category":"concert|theatre|opera|cinema|club|exhibition|market|talk|sports|family|other","summary":"one or two sentences in the local language","url":"https://source-page-for-this-event"}]}`

export function buildMessages({ city, country, from, to, known = [] }) {
  const fmt = (ts) => new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')
  const knownList = known.slice(0, 40).map(e => `- ${fmt(e.start)} ${e.title}`).join('\n')
  return [
    {
      role: 'system',
      content: 'You are an events scout. You search the web and report only real, specific, verifiable public events. ' +
        'Never invent an event, a date or a venue. Every event must carry the URL of the page you found it on. ' +
        'Answer with JSON only, no prose, no code fence.',
    },
    {
      role: 'user',
      content:
        `Find public events in ${city}${country ? ', ' + country : ''} that start between ${fmt(from)} and ${fmt(to)} (local time).\n` +
        'Search event listings, venue calendars and ticket sites. Prefer primary sources (the venue or the organiser) over aggregators.\n' +
        'Cover a mix: concerts, theatre, opera, cinema events, club nights, exhibitions, markets, talks.\n' +
        (knownList ? `These are already published, do not repeat them:\n${knownList}\n` : '') +
        `Return at most 20 events as JSON in exactly this shape:\n${SCHEMA_HINT}\n` +
        'Use local time in start/end. Omit any event whose date or venue you are not sure about.',
    },
  ]
}

export function parseCandidates(text) {
  const cleaned = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  let data
  try {
    data = JSON.parse(cleaned)
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('model did not return JSON')
    data = JSON.parse(m[0])
  }
  const list = Array.isArray(data) ? data : (data.events || [])
  return list
    .map(normalizeCandidate)
    .filter(c => c && c.title && c.start)
}

function normalizeCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null
  const start = toSeconds(raw.start)
  if (!start) return null
  const end = toSeconds(raw.end)
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

function toSeconds(v) {
  if (!v) return null
  if (typeof v === 'number') return Math.floor(v)
  if (/^\d{10}$/.test(v)) return parseInt(v, 10)
  const ms = Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(v) ? v : v.replace(' ', 'T'))
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

// A run: balance before, one paid call, balance after. The difference is the
// real cost and it is what the next visitor sees as the price estimate.
export async function runScout(acc, { city, country, lat, lon, from, to, known = [], model }) {
  const before = await getBalance(acc)
  if (!(before > 0)) throw new InsufficientBalance()
  const started = Math.floor(Date.now() / 1000)
  const res = await chat(acc, { model, messages: buildMessages({ city, country, from, to, known }) })
  let after = before
  try { after = await getBalance(acc) } catch { /* keep the estimate at 0 rather than fail the run */ }
  const candidates = parseCandidates(res.text)
  return {
    candidates,
    costUsd: Math.max(0, +(before - after).toFixed(4)),
    balance: after,
    model: res.model,
    usage: res.usage,
    startedAt: started,
    window: { from, to },
    city,
    lat,
    lon,
  }
}

// Candidate -> signed NIP-52 event. Coordinates come from the venue when we can
// geocode it, from the city centre otherwise, so "near me" still works.
export async function candidateToEvent(identity, candidate, { city, lat, lon }) {
  let place = null
  if (candidate.lat && candidate.lon) place = { lat: candidate.lat, lon: candidate.lon }
  else if (candidate.venue) {
    try { place = await geocodePlace(`${candidate.venue}, ${city}`) } catch { /* city centre it is */ }
  }
  const coords = place || { lat, lon }
  const d = await dedupId({ title: candidate.title, venue: candidate.venue, start: candidate.start })
  const template = {
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
    }),
  }
  return identity.sign(template)
}

export async function scoutRunEvent(identity, run, publishedCount) {
  const tags = [
    ['t', slugify(run.city)],
    ['found', String(run.candidates.length)],
    ['published', String(publishedCount)],
    ['cost_usd', run.costUsd.toFixed(4)],
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
    content: `Scouted ${run.city}: ${run.candidates.length} candidates, ${publishedCount} published, $${run.costUsd.toFixed(3)} of inference.`,
    tags,
  })
}
