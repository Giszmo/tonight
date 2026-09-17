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

export async function readPage(url, {
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  reader = READER,
  maxChars = MAX_CHARS,
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  if (!fetchImpl) throw new PageUnavailable(url, 'no fetch available')
  let direct = null
  try {
    const res = await get(fetchImpl, url, timeoutMs)
    if (res.ok) direct = htmlToText(await res.text())
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

function get(fetchImpl, url, timeoutMs) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
  return fetchImpl(url, {
    headers: { accept: 'text/html,text/plain,*/*' },
    redirect: 'follow',
    signal: ctl?.signal,
  }).finally(() => { if (timer) clearTimeout(timer) })
}

// Only ever applied to a direct fetch; the reader already returns markdown.
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
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
