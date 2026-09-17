// A fake PPQ, switched on with ?mock=1. It exists so the whole paid path -
// catalogue discovery, a multi-call harvest against a budget, the top-up sheet,
// the paid confetti - can be driven in a test browser without spending money,
// and so a reviewer can see the flow before funding anything. Nothing here
// touches the network; the real client is src/ppq.js.
import { InsufficientBalance, PPQ_BASE, DEFAULT_MODEL, sessionUrl, topUpUrl } from './ppq.js'

const LS = { account: 'tonight.mockppq' }
// Extraction from a page we supply carries no search fee, which is why it is
// the cheaper of the two as well as the complete one.
const COST = { catalogues: 0.0125, harvest: 0.0205, extract: 0.0043 }

const CATALOGUES = [
  { name: 'in München — das Stadtmagazin', url: 'https://www.in-muenchen.de/veranstaltungen', kind: 'magazine', covers: 'concerts, theatre, clubs, cinema, day by day' },
  // deliberately the section front page, like the real registry entry that
  // returned one event: it lists no dates, only links to the listings
  { name: 'muenchen.de Veranstaltungskalender', url: 'https://www.muenchen.de/veranstaltungen', kind: 'city', covers: 'the municipality’s own calendar' },
  { name: 'München Ticket', url: 'https://www.muenchenticket.de/events', kind: 'tickets', covers: 'ticketed events across the city' },
  { name: 'Gasteig HP8 Programm', url: 'https://www.gasteig.de/programm', kind: 'venue', covers: 'classical, talks, workshops' },
]

const SHOWS = [
  ['Kammerkonzert: Schostakowitsch Quartette', 'Gasteig HP8', 'concert'],
  ['Der Kirschgarten', 'Residenztheater', 'theatre'],
  ['Late Night Jazz Session', 'Unterfahrt', 'concert'],
  ['Open-Air-Kino: Perfect Days', 'Kino, Mond & Sterne', 'cinema'],
  ['Techno: Label Night', 'Blitz Club', 'club'],
  ['Führung: Blauer Reiter', 'Lenbachhaus', 'exhibition'],
  ['Slam im Substanz', 'Substanz', 'talk'],
  ['Tollwood Marktbühne', 'Tollwood', 'family'],
  ['Die Zauberflöte', 'Nationaltheater', 'opera'],
  ['Bauernmarkt', 'Wiener Platz', 'market'],
  ['Lesung: Neue Münchner Prosa', 'Literaturhaus', 'talk'],
  ['Improtheater Nachtschicht', 'Volkstheater', 'theatre'],
]

// The pages the fake catalogues serve. muenchen.de/veranstaltungen is a hub
// with no dates on it, exactly like the real one, so the run has to notice that
// and follow the listing it points at; the others are listings, one of them
// paginated.
const HUBS = { 'https://www.muenchen.de/veranstaltungen': ['https://www.muenchen.de/veranstaltungen/event/heute'] }

function mockPage(url) {
  if (HUBS[url]) {
    return `Veranstaltungen in München\n\nHighlights und Tipps\n` +
      HUBS[url].map(u => `* [Das Programm für heute](${u})`).join('\n') +
      '\n* [Museen](https://www.muenchen.de/veranstaltungen/museen)\n'
  }
  const src = CATALOGUES.find(c => url.startsWith(c.url)) || CATALOGUES[1]
  const idx = CATALOGUES.indexOf(src)
  const page = /[?&]seite=(\d+)/.exec(url) ? parseInt(/[?&]seite=(\d+)/.exec(url)[1], 10) : 1
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
  const lines = []
  for (let day = (page - 1) * 3; day < page * 3 + 1; day++) {
    for (let k = 0; k < 4; k++) {
      const show = SHOWS[(idx * 5 + day * 4 + k) % SHOWS.length]
      const at = new Date(midnight.getTime() + day * 86400000)
      at.setHours(18 + ((k * 2) % 6), k === 1 ? 30 : 0, 0, 0)
      lines.push(`* [${show[0]}](${src.url}/${slug(show[0])}-${day}) — ${local(at).replace('T', ' ')} — ${show[1]} — ${show[2]}`)
    }
  }
  const next = page < 2 ? `\n[Weiter](${src.url}?seite=${page + 1})\n` : '\n'
  return `${src.name}\n\nTermine im Kalender\n\n${lines.join('\n')}\n${next}`
}

// The fake model does what a real one does with a page we hand it: it reads the
// page and nothing else.
function extractFrom(prompt) {
  const body = prompt.split('--- page text of ')[1] || ''
  const url = body.slice(0, body.indexOf('\n')).replace(/ ---$/, '').trim()
  const events = [...body.matchAll(/^\* \[([^\]]+)\]\(([^)]+)\) — ([\d-]{10} [\d:]{5}) — ([^—]+) — (\w+)$/gm)]
    .map(m => ({
      title: m[1], url: m[2], start: m[3].replace(' ', 'T'), end: null,
      venue: m[4].trim(), address: m[4].trim() + ', München', category: m[5],
      summary: `${m[1]} im ${m[4].trim()}.`,
    }))
  // The ticket shop re-lists an event the city already has, under its own
  // wording, because real ones ignore a skip list too - that is what the
  // client-side dedup is there to catch.
  if (/muenchenticket/.test(url)) {
    const k = /^- ([\d-]+ [\d:]+) UTC (.+)$/m.exec(prompt)
    if (k) {
      const at = new Date(Date.parse(k[1].replace(' ', 'T') + 'Z') + 300000)
      const [title, venue = ''] = k[2].split(' @ ')
      events.unshift({
        title: title + ' (Tickets)', url: url + '/' + slug(title), start: local(at), end: null,
        venue, address: venue + ', München', category: 'other', summary: 'Tickets ab sofort.',
      })
    }
  }
  const listing = events.length ? [] : [...body.matchAll(/\((https?:\/\/[^)]+)\)/g)].map(m => m[1])
  const nextUrl = /\[Weiter\]\((https?:\/\/[^)]+)\)/.exec(body)?.[1] || ''
  return {
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    events, listing_urls: listing, next_url: nextUrl, more: !!nextUrl, covered_until: null, url,
  }
}

export function mockPpq() {
  let invoices = new Map()

  const stored = () => { try { return JSON.parse(localStorage.getItem(LS.account) || 'null') } catch { return null } }
  const store = (acc) => { localStorage.setItem(LS.account, JSON.stringify(acc)); return acc }

  async function createAccount() {
    return store({ creditId: 'mock-' + Math.random().toString(36).slice(2, 10), apiKey: 'mock-key', balance: 0, createdAt: Date.now() })
  }

  async function getBalance() { return Number(stored()?.balance || 0) }

  function charge(usd) {
    const acc = stored()
    acc.balance = Math.max(0, +(acc.balance - usd).toFixed(5))
    store(acc)
  }

  return {
    mock: true,
    PPQ_BASE, DEFAULT_MODEL, InsufficientBalance, sessionUrl, topUpUrl,
    storedAccount: stored,
    forgetAccount: () => localStorage.removeItem(LS.account),
    createAccount,
    ensureAccount: async () => stored() || createAccount(),
    adoptCreditId: async (creditId) => store({ creditId, apiKey: 'mock-key', balance: 1, adopted: true, createdAt: Date.now() }),
    getBalance,

    async createLightningTopup(acc, usd) {
      const id = 'mockinv-' + Math.random().toString(36).slice(2, 8)
      // paid a few seconds later, so the success state is reachable in a test
      invoices.set(id, { usd, paidAt: Date.now() + 5000 })
      return {
        invoice_id: id,
        crypto_amount_due: (usd / 76000).toFixed(8),
        lightning_invoice: 'lnbc' + Math.round(usd * 1e5) + 'n1mock' + 'p'.repeat(40) + id.replace(/-/g, ''),
        checkout_url: 'https://ppq.ai/checkout/' + id,
      }
    },

    async topupStatus(acc, id) {
      const inv = invoices.get(id)
      if (!inv) return { status: 'pending' }
      if (Date.now() < inv.paidAt) return { status: 'pending' }
      const account = stored()
      if (!account.paidInvoices?.includes(id)) {
        account.paidInvoices = [...(account.paidInvoices || []), id]
        account.balance = +(Number(account.balance || 0) + inv.usd * 1.05).toFixed(5)
        store(account)
      }
      return { status: 'paid', amount_paid: inv.usd }
    },

    // Fetching a page is free in the real run too, so the mock charges nothing
    // for it - and it never touches the network.
    async fetchPage(url) {
      await new Promise(r => setTimeout(r, 120))
      return mockPage(url)
    },

    async chat(acc, { messages, model = DEFAULT_MODEL, search = true }) {
      if (!(await getBalance() > 0)) throw new InsufficientBalance()
      const prompt = messages.map(m => m.content).join('\n')
      await new Promise(r => setTimeout(r, 400))
      if (/List the web pages that catalogue/.test(prompt)) {
        charge(COST.catalogues)
        return { text: JSON.stringify({ sources: CATALOGUES }), model: model + ':online', usage: null }
      }
      if (/--- page text of /.test(prompt)) {
        charge(COST.extract)
        return { text: JSON.stringify(extractFrom(prompt)), model, usage: null }
      }
      charge(COST.harvest)
      return { text: JSON.stringify(harvestFor(prompt)), model: model + (search ? ':online' : ''), usage: null }
    },
  }
}

// Deterministic-ish catalogue contents: each source knows a slice of the city,
// pass 2 returns later days, and one show is deliberately listed by two
// catalogues so the cross-source dedup is exercised.
function harvestFor(prompt) {
  const src = CATALOGUES.find(c => prompt.includes(c.url))
  const idx = src ? CATALOGUES.indexOf(src) : CATALOGUES.length
  const pass = /This is pass (\d+)/.exec(prompt)
  const page = pass ? parseInt(pass[1], 10) : 1
  const from = stamp(/starts between ([\d-]+ [\d:]+) UTC/.exec(prompt)?.[1])
  const to = stamp(/and ([\d-]+ [\d:]+) UTC/.exec(prompt)?.[1])
  // What the page told us it already has. A well-behaved catalogue honours it;
  // the ticket shop below deliberately does not, because real ones do not
  // either - that is what the client-side dedup is for.
  const knownLines = [...prompt.matchAll(/^- ([\d-]+ [\d:]+) UTC (.+)$/gm)].map(m => ({
    at: Math.floor(Date.parse(m[1].replace(' ', 'T') + 'Z') / 1000),
    title: m[2].split(' @ ')[0],
    venue: m[2].split(' @ ')[1] || '',
  }))
  const isKnown = (title, at) => knownLines.some(k => k.title === title && Math.abs(k.at - at) < 1800)

  const days = Math.max(1, Math.min(7, Math.round((to - from) / 86400)))
  const out = []
  // the ticket shop re-lists something the city already has, under its own wording
  if (src?.kind === 'tickets' && knownLines.length) {
    const k = knownLines[0]
    out.push({
      title: k.title + ' (Tickets)',
      start: local(new Date((k.at + 300) * 1000)),
      end: null,
      venue: k.venue,
      address: k.venue + ', München',
      category: 'other',
      summary: 'Tickets ab sofort.',
      url: src.url + '/' + slug(k.title),
    })
  }
  const perDay = src ? 3 : 1
  for (let day = (page - 1) * 3; day < Math.min(days, page * 3); day++) {
    for (let k = 0; k < perDay; k++) {
      const show = SHOWS[(idx * 5 + day * perDay + k) % SHOWS.length]
      const start = new Date((from + day * 86400) * 1000)
      start.setHours(18 + ((k * 2) % 6), k === 1 ? 30 : 0, 0, 0)
      const title = show[0]
      if (isKnown(title, Math.floor(start.getTime() / 1000))) continue
      out.push({
        title,
        start: local(start),
        end: null,
        venue: show[1],
        address: show[1] + ', München',
        category: show[2],
        summary: `${title} im ${show[1]}.`,
        url: (src?.url || 'https://www.muenchen.de/veranstaltungen') + '/' + slug(title) + '-' + day,
      })
    }
  }
  return { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, events: out, more: page < 2 && !!src, covered_until: local(new Date((from + Math.min(days, page * 3) * 86400) * 1000)) }
}

const stamp = (s) => s ? Math.floor(Date.parse(s.replace(' ', 'T') + 'Z') / 1000) : Math.floor(Date.now() / 1000)
const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
