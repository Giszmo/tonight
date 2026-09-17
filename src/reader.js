// Reading a catalogue page from a page that has no server of its own.
//
// The scouting run used to ask a web-search model to "walk the listing". It
// cannot: `:online` is a search, so the model only ever saw a few snippets
// about the catalogue and answered from those - one or two events for a city
// that had forty that evening. So we fetch the listing ourselves and hand the
// model its text.
//
// A browser cannot fetch a random news site directly: almost none of them send
// `access-control-allow-origin`. r.jina.ai does, it reflects the caller's
// origin, it renders the page and returns markdown, and it is free without a
// key. Direct fetch is tried first anyway, for the rare catalogue that allows
// it and for the test harness, and the reader is the fallback.

export const READER = 'https://r.jina.ai/'
// What one extraction call is shown. ~15k tokens, well inside the context and
// the budget.
export const SLICE_CHARS = 60000
// What we keep of a page. A city-wide film programme is genuinely this long:
// in-muenchen.de/kino/alle-kinos.html is 191k characters, 41 cinemas and 661
// showings on one server-rendered page. Cutting it at one slice threw away 30
// of those cinemas before the model ever saw them, so the fetch keeps the whole
// thing and the run reads it a slice at a time.
export const MAX_CHARS = 400000
export const FETCH_TIMEOUT_MS = 30000

export class PageUnavailable extends Error {
  constructor(url, cause) { super(`could not read ${url}: ${cause}`); this.name = 'PageUnavailable' }
}

export async function readPage(url, opts = {}) {
  // Same seam, two shapes: the run asks for text to extract from and, for the
  // pages that carry schema.org, the HTML those <script> blocks live in.
  if (opts.html) return readHtml(url, opts)
  const {
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    reader = READER,
    maxChars = MAX_CHARS,
    timeoutMs = FETCH_TIMEOUT_MS,
    // A browser is refused by almost every site here and falls through to the
    // reader, which renders the page; node is refused by nobody and gets the
    // unrendered HTML instead. A measuring harness has to be able to say "be a
    // browser about it", or it measures a path no visitor is ever on.
    allowDirect = true,
  } = opts
  if (!fetchImpl) throw new PageUnavailable(url, 'no fetch available')
  let direct = null
  if (allowDirect) try {
    const res = await get(fetchImpl, url, timeoutMs)
    if (res.ok) direct = htmlToText(await res.text(), url)
  } catch { /* the usual case: CORS. The reader below is the answer. */ }
  if (direct && direct.length > 500) return clip(direct, maxChars)

  let err = 'reader refused'
  try {
    const res = await get(fetchImpl, reader + url, timeoutMs)
    if (res.ok) {
      const text = await res.text()
      if (text.trim()) return clip(text, maxChars)
      err = 'reader returned nothing'
    } else err = `reader ${res.status}`
  } catch (e) { err = String(e?.message || e) }
  if (direct) return clip(direct, maxChars)   // short, but better than nothing
  throw new PageUnavailable(url, err)
}

function get(fetchImpl, url, timeoutMs, headers = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
  return fetchImpl(url, {
    headers: { accept: 'text/html,text/plain,*/*', ...headers },
    redirect: 'follow',
    signal: ctl?.signal,
  }).finally(() => { if (timer) clearTimeout(timer) })
}

// Only ever applied to a direct fetch; the reader already returns markdown.
//
// Links survive it, as `[text](url)`, because that is what the reader produces
// and because a listing without them is unusable twice over: every event loses
// the URL it must carry to be published, and an index that names its entries
// without dating them loses the only way to reach the pages that date them.
export function htmlToText(html, base = '') {
  return String(html || '')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>([\s\S]*?)<\/a>/gi,
      (m, _q, dq, sq, bare, inner) => {
        const href = (dq ?? sq ?? bare ?? '').trim()
        const label = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) return label
        const abs = base ? absolute(href, base) : href
        return abs ? `[${label}](${abs})` : label
      })
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

// A listing's own text is front-loaded with navigation. Cutting from the end
// keeps the events; cutting from the middle would split an entry in half.
function clip(text, maxChars) {
  return text.length > maxChars ? text.slice(0, maxChars) + '\n[page truncated]' : text
}

export function sameHost(a, b) {
  try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, '') }
  catch { return false }
}

export function absolute(href, base) {
  try { return new URL(href, base).toString() } catch { return '' }
}

// ---------- structured data on the page ----------
//
// Some pages carry their programme twice: once for a reader and once for search
// engines, as schema.org JSON-LD. The second copy is exact to the minute,
// carries its own UTC offset, needs no model call and cannot be hallucinated,
// so it is worth taking wherever it is there.
//
// Counted before building this, on sixteen event pages across Lisbon and
// Munich: only ma.to's event pages and Eventbrite's city listing carry an
// `Event` with a `startDate`. So this is a free exact bonus where it exists,
// never a replacement for reading the page. cartazculturallisboa.pt's film
// index is the case it rescues - 204 links, one clock time in the whole page.
//
// The markdown the reader returns has no <script> in it, and htmlToText strips
// them, so this needs the HTML: r.jina.ai returns the rendered DOM when asked
// for `x-return-format: html`, with the same open CORS as the markdown form.
export const STRUCTURED_MAX_CHARS = 800000

export async function readHtml(url, {
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  reader = READER,
  maxChars = STRUCTURED_MAX_CHARS,
  timeoutMs = FETCH_TIMEOUT_MS,
  allowDirect = true,
} = {}) {
  if (!fetchImpl) throw new PageUnavailable(url, 'no fetch available')
  if (allowDirect) try {
    const res = await get(fetchImpl, url, timeoutMs)
    if (res.ok) {
      const html = await res.text()
      if (html.includes('<')) return clip(html, maxChars)
    }
  } catch { /* CORS, as usual */ }
  let err = 'reader refused'
  try {
    const res = await get(fetchImpl, reader + url, timeoutMs, { 'x-return-format': 'html' })
    if (res.ok) {
      const html = await res.text()
      if (html.trim()) return clip(html, maxChars)
      err = 'reader returned nothing'
    } else err = `reader ${res.status}`
  } catch (e) { err = String(e?.message || e) }
  throw new PageUnavailable(url, err)
}

// schema.org spells a film showing ScreeningEvent and a gig MusicEvent; both
// are Events. Anything with a start date and a name counts, whatever the
// subtype, and the subtype is a free category guess.
const LD_CATEGORY = {
  screeningevent: 'cinema',
  musicevent: 'concert',
  theaterevent: 'theatre',
  danceevent: 'theatre',
  comedyevent: 'other',
  exhibitionevent: 'exhibition',
  sportsevent: 'sports',
  childrensevent: 'family',
  educationevent: 'talk',
  literaryevent: 'talk',
  foodevent: 'market',
  festival: 'other',
}

export function extractJsonLdEvents(html, baseUrl = '') {
  const out = []
  const blocks = String(html || '').match(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>[\s\S]*?<\/script>/gi) || []
  for (const block of blocks) {
    const body = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>\s*$/i, '')
    let data
    try { data = JSON.parse(body) } catch { continue }
    walkLd(data, out, baseUrl, new Set())
  }
  // One page can repeat the same event in several graphs.
  const seen = new Set()
  return out.filter(e => {
    const key = `${e.title}|${e.start}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function walkLd(node, out, baseUrl, seen, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return
  if (Array.isArray(node)) { for (const n of node) walkLd(n, out, baseUrl, seen, depth + 1); return }
  if (seen.has(node)) return
  seen.add(node)
  const types = (Array.isArray(node['@type']) ? node['@type'] : [node['@type']])
    .filter(t => typeof t === 'string').map(t => t.toLowerCase())
  if (types.some(t => t.endsWith('event')) && node.startDate && node.name) {
    const ev = ldEvent(node, types, baseUrl)
    if (ev) out.push(ev)
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') walkLd(v, out, baseUrl, seen, depth + 1)
  }
}

function ldEvent(node, types, baseUrl) {
  // A cancelled or postponed show is worse than no show: it sends somebody out.
  const status = String(node.eventStatus || '').toLowerCase()
  if (status.includes('cancelled') || status.includes('postponed')) return null
  const place = firstOf(node.location)
  const address = place && typeof place === 'object' ? place.address : null
  const geo = place && typeof place === 'object' ? place.geo : null
  const url = typeof node.url === 'string' ? absolute(node.url, baseUrl || node.url) : baseUrl
  return {
    title: text(node.name),
    // Already an ISO stamp with an offset in almost every case, which the
    // candidate parser reads without needing to know the city's zone at all.
    start: typeof node.startDate === 'string' ? node.startDate : '',
    end: typeof node.endDate === 'string' ? node.endDate : null,
    venue: text(typeof place === 'string' ? place : place?.name),
    address: addressOf(address),
    category: LD_CATEGORY[types.find(t => LD_CATEGORY[t])] || 'other',
    summary: text(node.description).slice(0, 400),
    url: /^https?:\/\//.test(url) ? url : (baseUrl || ''),
    lat: Number(geo?.latitude),
    lon: Number(geo?.longitude),
  }
}

const firstOf = (v) => (Array.isArray(v) ? v[0] : v)
const text = (v) => String(typeof v === 'string' ? v : (v?.['@value'] || '')).replace(/\s+/g, ' ').trim()

function addressOf(a) {
  if (!a) return ''
  if (typeof a === 'string') return text(a)
  return [a.streetAddress, a.postalCode, a.addressLocality].map(text).filter(Boolean).join(' ')
}
