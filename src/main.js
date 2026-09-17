// Tonight - a single page that reads local events off nostr for free and lets
// whoever wants fresher data pay for one scouting run, in their own browser.
import {
  getIdentity, fetchCityEvents, fetchEndorsements, fetchFollows, fetchScoutRuns,
  fetchSources, publishSources, publishRsvp, publish, getRelays, setRelays, DEFAULT_RELAYS,
} from './nostr.js'
import { groupCopies } from './events.js'
import { haversineKm, geocodeCity, slugify } from './geo.js'
import * as realPpq from './ppq.js'
import { mockPpq } from './mockppq.js'
import { runScout, candidateToEvent, scoutRunEvent, findDuplicate, makeGeocoder } from './scout.js'
import qrcode from 'qrcode-generator'

// ?mock=1 swaps in a fake PPQ so the whole paid path can be driven without
// spending money (src/mockppq.js). The real client is the default.
let ppq = realPpq

const LS = { cities: 'tonight.cities', active: 'tonight.active' }
const DEFAULT_CITIES = [{ name: 'München', country: 'Germany', lat: 48.1374, lon: 11.5755 }]

const state = {
  cities: [],
  active: 0,
  near: null,          // {lat, lon, name} from the browser geolocation API
  usingNear: false,
  when: 'tonight',
  radiusKm: 30,
  groups: [],
  endorsements: new Map(),
  follows: new Set(),
  identity: null,
  runs: [],
  sources: [],
  balance: null,
  busy: false,
}

const $ = (id) => document.getElementById(id)
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : String(v))
  }
  for (const kid of kids) if (kid) n.append(kid)
  return n
}

// ---------- time windows ----------

export function timeWindow(kind, now = new Date()) {
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
  const secs = (d) => Math.floor(d.getTime() / 1000)
  if (kind === 'tonight') {
    const end = startOfDay(now)
    end.setDate(end.getDate() + 1)
    end.setHours(5, 0, 0, 0)          // the night belongs to the day it started
    return { from: secs(now), to: secs(end), label: 'tonight' }
  }
  if (kind === 'weekend') {
    const fri = startOfDay(now)
    const dow = fri.getDay()          // 0 Sun .. 6 Sat
    const untilFriday = (5 - dow + 7) % 7
    // Saturday and Sunday count as the weekend you are already in
    if (dow === 6 || dow === 0) fri.setDate(fri.getDate() - (dow === 6 ? 1 : 2))
    else fri.setDate(fri.getDate() + untilFriday)
    fri.setHours(16, 0, 0, 0)
    const sun = new Date(fri)
    sun.setDate(sun.getDate() + 2)
    sun.setHours(23, 59, 59, 0)
    return { from: Math.max(secs(now), secs(fri)), to: secs(sun), label: 'this weekend' }
  }
  const week = new Date(now)
  week.setDate(week.getDate() + 7)
  return { from: secs(now), to: secs(week), label: 'the next 7 days' }
}

const WHENS = [['tonight', 'Tonight'], ['weekend', 'Weekend'], ['week', '7 days']]

// ---------- formatting ----------

const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })

export function fmtAgo(seconds) {
  if (!Number.isFinite(seconds)) return 'never'
  const s = Math.max(0, Math.floor(seconds))
  if (s < 90) return 'just now'
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

export function median(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

// ---------- city handling ----------

function loadCities() {
  try {
    const stored = JSON.parse(localStorage.getItem(LS.cities) || 'null')
    state.cities = Array.isArray(stored) && stored.length ? stored : DEFAULT_CITIES.slice()
  } catch { state.cities = DEFAULT_CITIES.slice() }
  const a = parseInt(localStorage.getItem(LS.active) || '0', 10)
  state.active = Number.isFinite(a) && a < state.cities.length ? a : 0
  const params = new URLSearchParams(location.search)
  if (params.get('when')) state.when = params.get('when')
  const city = params.get('city')
  if (city) {
    const i = state.cities.findIndex(c => slugify(c.name) === slugify(city))
    if (i >= 0) state.active = i
  }
}

function saveCities() {
  localStorage.setItem(LS.cities, JSON.stringify(state.cities))
  localStorage.setItem(LS.active, String(state.active))
}

function currentPlace() {
  if (state.usingNear && state.near) return state.near
  return state.cities[state.active] || DEFAULT_CITIES[0]
}

function syncUrl() {
  const p = new URLSearchParams()
  p.set('city', state.usingNear ? 'near' : slugify(currentPlace().name))
  p.set('when', state.when)
  // keep the mock switch in the URL: dropping it would silently put a session
  // that is clicking around on fake money back on the real, paying API
  if (ppq.mock) p.set('mock', '1')
  history.replaceState(null, '', '?' + p.toString())
}

async function useNearMe() {
  if (!navigator.geolocation) { setStatus('This browser has no geolocation.'); return }
  setStatus('Asking your browser where you are…')
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 10000, maximumAge: 300000 }))
    const { latitude: lat, longitude: lon } = pos.coords
    let name = 'Near me'
    try {
      const hits = await geocodeCity(`${lat},${lon}`)
      if (hits[0]) name = hits[0].name
    } catch { /* keep the generic label */ }
    state.near = { name, lat, lon, country: '' }
    state.usingNear = true
    renderCities()
    await load()
  } catch (err) {
    setStatus('Location denied - pick a city instead.')
  }
}

// ---------- data ----------

async function load() {
  const place = currentPlace()
  const win = timeWindow(state.when)
  setStatus(`Reading relays for ${place.name}…`)
  state.groups = []
  render()
  const [events, runs, sources] = await Promise.all([
    fetchCityEvents({ lat: place.lat, lon: place.lon, city: place.name, from: win.from, to: win.to }),
    fetchScoutRuns(place.name),
    fetchSources(place.name, { lat: place.lat, lon: place.lon }),
  ])
  state.runs = runs
  state.sources = sources
  const near = events.filter(e => {
    if (!e.coords) return matchesCityText(e, place)
    const km = haversineKm({ lat: place.lat, lon: place.lon }, e.coords)
    return km !== null && km <= state.radiusKm
  })
  state.groups = groupCopies(near).sort((a, b) => a.canonical.start - b.canonical.start)
  render()
  setStatus('')
  const addresses = state.groups.flatMap(g => g.copies.map(c => c.address))
  const [endorsements, follows] = await Promise.all([
    fetchEndorsements(addresses),
    state.identity ? fetchFollows(state.identity.pubkey) : Promise.resolve(new Set()),
  ])
  state.endorsements = endorsements
  state.follows = follows
  render()
}

function matchesCityText(e, place) {
  const hay = (e.venue + ' ' + e.hashtags.join(' ')).toLowerCase()
  return hay.includes(place.name.toLowerCase()) || e.hashtags.includes(slugify(place.name))
}

function endorsementsFor(group) {
  let going = new Set(), likes = new Set()
  for (const c of group.copies) {
    const rec = state.endorsements.get(c.address)
    if (!rec) continue
    for (const p of rec.going) going.add(p)
    for (const p of rec.likes) likes.add(p)
  }
  const fromFollows = [...going, ...likes].filter(p => state.follows.has(p)).length
  return { going: going.size, likes: likes.size, fromFollows, mine: state.identity && (going.has(state.identity.pubkey) || likes.has(state.identity.pubkey)) }
}

// ---------- rendering ----------

function setStatus(msg) {
  $('status').textContent = msg || ''
  $('status').hidden = !msg
}

function renderCities() {
  const box = $('cities')
  box.replaceChildren()
  box.append(el('button', {
    class: 'chip' + (state.usingNear ? ' on' : ''),
    onclick: useNearMe,
    title: 'use this device\'s location',
  }, el('span', { text: state.near && state.usingNear ? `Near me · ${state.near.name}` : 'Near me' })))
  state.cities.forEach((c, i) => {
    const chip = el('button', {
      class: 'chip' + (!state.usingNear && i === state.active ? ' on' : ''),
      onclick: async () => { state.usingNear = false; state.active = i; saveCities(); syncUrl(); renderCities(); await load() },
      text: c.name,
    })
    chip.append(el('span', {
      class: 'x', text: '×', title: 'unpin',
      onclick: (ev) => { ev.stopPropagation(); state.cities.splice(i, 1); if (state.active >= state.cities.length) state.active = 0; saveCities(); renderCities(); load() },
    }))
    box.append(chip)
  })
}

function renderWhen() {
  const box = $('when')
  box.replaceChildren(...WHENS.map(([key, label]) => el('button', {
    class: 'chip' + (state.when === key ? ' on' : ''),
    role: 'tab',
    text: label,
    onclick: async () => { state.when = key; syncUrl(); renderWhen(); await load() },
  })))
}

function renderIdent() {
  const id = state.identity
  if (!id) return
  const short = id.npub.slice(0, 9) + '…' + id.npub.slice(-4)
  $('ident').replaceChildren(el('button', {
    class: 'linkish',
    text: (id.mode === 'nip07' ? 'signer · ' : 'guest key · ') + short,
    onclick: openIdentitySheet,
  }))
}

function renderRunInfo() {
  const place = currentPlace()
  const box = $('runinfo')
  const last = state.runs[0]
  const cost = median(state.runs.slice(0, 5).map(r => r.costUsd))
  const bits = []
  if (last) {
    const ago = fmtAgo(Math.floor(Date.now() / 1000) - last.at)
    const keys = new Set(state.runs.filter(r => r.at > last.at - 7 * 86400).map(r => r.pubkey)).size
    bits.push(`Last scouted ${ago} by ${keys} ${keys === 1 ? 'key' : 'keys'}, ${last.found} found, ${last.published} published.`)
  } else {
    bits.push(`${place.name} has never been scouted from this page.`)
  }
  const rate = eventsPerDollar()
  bits.push(cost !== null
    ? `Recent runs here cost ${usd(cost)}${rate ? ` and found about ${Math.round(rate / 10)} events per 10 cents` : ''}.`
    : 'A run costs what you let it: it walks the city catalogues until your budget is gone.')
  if (state.sources.length) bits.push(`${state.sources.length} catalogues known.`)
  if (state.balance !== null) bits.push(`Balance ${usd(state.balance)}.`)
  box.textContent = bits.join(' ')
}

// PPQ quotes the amount due in BTC; wallets and humans think in sats.
const satsFromBtc = (btc) => Number.isFinite(Number(btc)) ? Math.round(Number(btc) * 1e8).toLocaleString() : '?'

// Costs here run from a fraction of a cent to a few dollars, so two decimals
// lose the interesting part and three add a dead zero to $0.05.
const usd = (v) => {
  const n = Number(v || 0)
  if (!n || Math.abs(n) >= 0.1) return '$' + n.toFixed(2)
  return '$' + n.toFixed(3).replace(/0$/, '')
}

function render() {
  renderCities()
  renderWhen()
  renderIdent()
  renderRunInfo()
  const list = $('list')
  list.replaceChildren()
  let lastDay = ''
  for (const g of state.groups) {
    const e = g.canonical
    const day = fmtDay(e.start)
    if (day !== lastDay) { list.append(el('li', { class: 'daysep', text: day })); lastDay = day }
    list.append(renderCard(g))
  }
  const win = timeWindow(state.when)
  $('empty').hidden = state.groups.length > 0
  $('empty').replaceChildren(
    el('p', { text: `Nothing on the relays for ${currentPlace().name} ${win.label}.` }),
    el('p', { class: 'dim', text: 'That is the normal state for a city nobody has scouted yet. A scouting run below fills it for everyone.' }),
  )
}

function renderCard(group) {
  const e = group.canonical
  const place = currentPlace()
  const km = e.coords ? haversineKm({ lat: place.lat, lon: place.lon }, e.coords) : null
  const end = endorsementsFor(group)
  const meta = [e.venue || 'venue unknown']
  if (km !== null) meta.push(km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`)
  if (group.copies.length > 1) meta.push(`${group.copies.length} sources`)

  const going = el('button', {
    class: 'going' + (end.mine ? ' on' : ''),
    onclick: () => onGoing(group, going),
  }, el('span', { text: end.mine ? 'going ✓' : 'going' }))

  const counts = []
  if (end.going) counts.push(`${end.going} going`)
  if (end.likes) counts.push(`${end.likes} interested`)
  if (end.fromFollows) counts.push(`${end.fromFollows} you follow`)

  return el('li', { class: 'card' },
    el('div', { class: 'time' }, el('strong', { text: e.allDay ? 'all day' : fmtTime(e.start) })),
    el('div', { class: 'body' },
      el('h3', { text: e.title }),
      e.summary ? el('p', { class: 'summary', text: e.summary.slice(0, 220) }) : null,
      el('p', { class: 'meta', text: meta.join(' · ') }),
      el('p', { class: 'tags' },
        ...displayTags(e, place).map(t => el('span', { class: 'tag', text: '#' + t })),
      ),
      el('p', { class: 'actions' },
        going,
        counts.length ? el('span', { class: 'counts', text: counts.join(' · ') }) : null,
        ...group.copies.flatMap(c => c.refs.slice(0, 1)).map(safeUrl).filter(Boolean).slice(0, 2).map(url =>
          el('a', { class: 'src', href: url, target: '_blank', rel: 'noopener', text: sourceLabel(url) })),
      ),
    ),
  )
}

// The city tags are what made the event findable; on a page that is already
// showing one city they are noise.
function displayTags(e, place) {
  const hidden = new Set([slugify(place.name), place.name.toLowerCase()])
  const seen = new Set()
  return e.hashtags.filter(t => {
    const key = slugify(t)
    if (hidden.has(t.toLowerCase()) || hidden.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 4)
}

function sourceLabel(url) {
  try { return 'source: ' + new URL(url).hostname.replace(/^www\./, '') } catch { return 'source' }
}

// Source links come off public relays, so anyone can put anything in an `r`
// tag. Only http(s) is ever turned into a link.
function safeUrl(url) {
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null
  } catch { return null }
}

async function onGoing(group, button) {
  button.disabled = true
  try {
    await publishRsvp(state.identity, group.canonical)
    button.classList.add('on')
    button.textContent = 'going ✓'
  } catch (err) {
    button.textContent = 'failed'
    console.error(err)
    setStatus('Could not publish your RSVP: ' + err.message)
  } finally {
    button.disabled = false
  }
}

// ---------- sheets ----------

function openSheet(...nodes) {
  $('sheet-body').replaceChildren(...nodes)
  $('sheet').showModal()
}

function openIdentitySheet() {
  const id = state.identity
  const acc = ppq.storedAccount()
  const nodes = [
    el('h2', { text: 'Your keys' }),
    el('p', { class: 'dim', text: id.mode === 'nip07'
      ? 'A nostr signer extension is signing for you, so everything you publish carries your own reputation.'
      : 'This page generated a guest key in this browser. It is a real nostr identity - copy the nsec if you want to keep it.' }),
    el('p', {}, el('code', { class: 'mono', text: id.npub })),
  ]
  if (id.nsec) nodes.push(el('details', {}, el('summary', { text: 'show the private key' }), el('code', { class: 'mono', text: id.nsec })))
  nodes.push(el('h2', { text: 'PPQ credit' }))
  if (acc) {
    nodes.push(
      el('p', { class: 'dim', text: 'Your credit id is your PPQ login. Copy it: it is the only way to reach this balance from another browser.' }),
      el('p', {}, el('code', { class: 'mono', text: acc.creditId })),
      el('p', {},
        el('button', { class: 'ghost', text: 'copy credit id', onclick: () => navigator.clipboard?.writeText(acc.creditId) }),
        el('a', { class: 'ghost', href: ppq.sessionUrl(acc.creditId), target: '_blank', rel: 'noopener', text: 'continue at ppq.ai →' }),
      ),
    )
  } else {
    nodes.push(el('p', { class: 'dim', text: 'No PPQ account yet. One is created the first time you scout.' }))
  }
  nodes.push(el('p', {}, el('button', { class: 'ghost', text: 'paste an existing credit id', onclick: openAdoptSheet })))
  openSheet(...nodes)
}

function openAdoptSheet() {
  const input = el('input', { type: 'text', placeholder: 'credit id from ppq.ai', class: 'wide' })
  const msg = el('p', { class: 'dim' })
  openSheet(
    el('h2', { text: 'Use your own PPQ credit' }),
    el('p', { class: 'dim', text: 'The page mints a capped key from your credit id, so it can never spend more than the cap.' }),
    input,
    el('p', {}, el('button', {
      class: 'primary',
      text: 'mint a $1 capped key',
      onclick: async () => {
        msg.textContent = 'talking to PPQ…'
        try {
          await ppq.adoptCreditId(input.value.trim(), { capUsd: 1 })
          state.balance = await ppq.getBalance()
          msg.textContent = 'Done. Balance: ' + usd(state.balance)
          renderRunInfo()
        } catch (err) { msg.textContent = err.message }
      },
    })),
    msg,
  )
}

function openSettingsSheet() {
  const ta = el('textarea', { class: 'wide mono', rows: 5 })
  ta.value = getRelays().join('\n')
  openSheet(
    el('h2', { text: 'Relays' }),
    el('p', { class: 'dim', text: 'Where this page reads and publishes. One per line.' }),
    ta,
    el('p', {},
      el('button', { class: 'primary', text: 'save', onclick: async () => {
        setRelays(ta.value.split('\n').map(s => s.trim()).filter(Boolean))
        $('sheet').close()
        await load()
      } }),
      el('button', { class: 'ghost', text: 'defaults', onclick: () => { ta.value = DEFAULT_RELAYS.join('\n') } }),
    ),
    el('h2', { text: 'Radius' }),
    el('p', { class: 'dim', text: `Events further than ${state.radiusKm} km from the city centre are hidden.` }),
  )
}

// ---------- scouting ----------

const BUDGETS = [0.05, 0.25, 1]

// What a city costs is not a guess: past runs recorded what they were charged
// and how many events came back, so the offer is "this much money buys about
// this many events" in the units the visitor is about to spend.
// Pooled, not a median of ratios: one lucky run of four events for a third of a
// cent extrapolates to hundreds per dollar, which is not a promise this page
// should make. Quote a yield only once there is enough history to mean
// something, and stay quiet otherwise.
function eventsPerDollar() {
  const runs = state.runs.filter(r => r.costUsd > 0 && r.found > 0).slice(0, 8)
  const found = runs.reduce((a, r) => a + r.found, 0)
  const cost = runs.reduce((a, r) => a + r.costUsd, 0)
  if (runs.length < 2 || found < 10 || cost < 0.02) return null
  return found / cost
}

async function onScout() {
  if (state.busy) return
  const btn = $('scout')
  btn.disabled = true
  try {
    const acc = await ppq.ensureAccount()
    try { state.balance = await ppq.getBalance(acc) } catch { /* shown as unknown below */ }
    renderRunInfo()
    if (!(state.balance > 0)) { await openTopupSheet(acc); return }
    openScoutSheet(acc)
  } catch (err) {
    setStatus('PPQ is not reachable: ' + err.message)
    console.error(err)
  } finally {
    btn.disabled = false
  }
}

// Before spending, the visitor picks how much. The run walks catalogues until
// that budget is gone, so the number on this button is the only thing standing
// between "4 events" and "the whole week".
function openScoutSheet(acc) {
  const place = currentPlace()
  const win = timeWindow(state.when)
  const rate = eventsPerDollar()
  const options = [...BUDGETS.filter(v => v <= state.balance + 1e-9), state.balance]
    .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
    .sort((a, b) => a - b)
  let budget = options.includes(0.25) ? 0.25 : options[options.length - 1]

  // The catalogue registry is the cheap path; paying to look for more of them
  // is worth it when the city is new to us or the list has gone quiet.
  const newest = state.sources.length ? Math.max(...state.sources.map(s => s.createdAt || 0)) : 0
  const staleDays = newest ? (Date.now() / 1000 - newest) / 86400 : Infinity
  const expandBox = el('input', { type: 'checkbox', checked: state.sources.length < 4 || staleDays > 30 })

  const yieldLine = el('p', { class: 'dim' })
  const chips = el('p', { class: 'budgets' })
  const renderBudgets = () => {
    chips.replaceChildren(...options.map(v => el('button', {
      class: 'chip' + (v === budget ? ' on' : ''),
      text: v === state.balance ? `all of it · ${usd(v)}` : usd(v),
      onclick: () => { budget = v; renderBudgets() },
    })))
    yieldLine.textContent = rate
      ? `About ${Math.round(rate * budget)} events at recent prices for ${place.name}.`
      : 'Nobody has scouted this city from here yet, so the yield is unknown. A first run is the measurement.'
  }
  renderBudgets()

  openSheet(
    el('h2', { text: `Scout ${place.name} · ${win.label}` }),
    el('p', { class: 'dim', text: state.sources.length
      ? `${state.sources.length} catalogues for ${place.name} are already on the relays (${state.sources.slice(0, 3).map(s => hostLabel(s.url)).join(', ')}${state.sources.length > 3 ? ', …' : ''}). The run walks them page by page.`
      : `No catalogues known for ${place.name} yet - the city magazine, the town calendar, ticket sites, the big venues. One call finds them and the list is published for everyone.` }),
    el('p', { class: 'dim', text: `${state.groups.length} events are already listed here. They go into the search as "skip these" and are filtered out again, so you pay for what is missing.` }),
    el('p', {}, el('label', { class: 'check' },
      expandBox,
      el('span', { text: state.sources.length
        ? 'also look for catalogues we do not know yet (one extra call)'
        : 'find the catalogues first (one call)' }),
    )),
    el('h2', { text: 'Spend at most' }),
    chips,
    yieldLine,
    el('p', {},
      el('button', { class: 'primary', text: 'Start the run', onclick: () => { $('sheet').close(); doScout(acc, budget, expandBox.checked ? 'always' : 'never') } }),
      el('button', { class: 'ghost', text: 'top up first', onclick: () => openTopupSheet(acc) }),
    ),
    el('p', { class: 'dim', text: `Balance ${usd(state.balance)}. You see every candidate before anything is published, and you sign what you publish.` }),
  )
}

const hostLabel = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }

async function doScout(acc, budgetUsd, discover = 'auto') {
  state.busy = true
  const place = currentPlace()
  const win = timeWindow(state.when)
  const btn = $('scout')
  btn.disabled = true
  btn.textContent = 'Scouting…'

  let stop = false
  const lines = el('ol', { class: 'runlog' })
  const head = el('p', { class: 'dim', text: 'starting…' })
  const fill = el('i')
  const bar = el('div', { class: 'bar' }, fill)
  const stopBtn = el('button', {
    class: 'ghost',
    text: 'stop after this call',
    onclick: (ev) => { stop = true; ev.target.disabled = true; ev.target.textContent = 'stopping…' },
  })
  openSheet(
    el('h2', { text: `Scouting ${place.name} · ${win.label}` }),
    head, bar, lines,
    el('p', {}, stopBtn),
  )

  // Several catalogues are read at once, so a line belongs to its job rather
  // than to the bottom of the list: "fetching X" turns into "X: 12 events" in
  // place, while the other two carry on next to it.
  const jobLines = new Map()
  const onProgress = ({ id, phase, label, spent, budget, found }) => {
    head.textContent = `${usd(spent)} of ${usd(budget)} spent · ${found} new events so far`
    fill.style.width = Math.min(100, (spent / (budget || 1)) * 100).toFixed(1) + '%'
    if (!label || phase === 'done') return
    const existing = id && jobLines.get(id)
    if (existing) { existing.textContent = label; return }
    const li = el('li', { text: label })
    if (id) jobLines.set(id, li)
    lines.append(li)
    lines.scrollTop = lines.scrollHeight
  }

  try {
    const run = await runScout(acc, {
      city: place.name,
      country: place.country,
      lat: place.lat,
      lon: place.lon,
      from: win.from,
      to: win.to,
      known: state.groups.flatMap(g => g.copies),
      sources: state.sources.length ? state.sources : null,
      discover,
      budgetUsd,
      api: ppq,
      // ?mock=1 serves its catalogue pages from memory, so a demo run never
      // hits a real site; a real run fetches them (src/reader.js).
      fetchPage: ppq.fetchPage,
      onProgress,
      shouldStop: () => stop,
    })
    state.balance = run.balance
    openCandidateSheet(run)
  } catch (err) {
    if (err instanceof ppq.InsufficientBalance) {
      await openTopupSheet(ppq.storedAccount())
    } else {
      $('sheet').close()
      setStatus('Scouting failed: ' + err.message)
      console.error(err)
    }
  } finally {
    state.busy = false
    btn.disabled = false
    btn.textContent = 'Scout this city now'
    renderRunInfo()
  }
}

function openCandidateSheet(run) {
  const known = state.groups.flatMap(g => g.copies)
  const rows = []
  const list = el('div', { class: 'candidates' })
  let dupCount = 0
  let lastDay = ''
  for (const c of run.candidates) {
    // The model was told what we have; this is the check that actually holds,
    // and it is the same matcher the listing uses to collapse copies.
    const dup = findDuplicate(c, known)
    if (dup) dupCount++
    const day = fmtDay(c.start)
    if (day !== lastDay) { list.append(el('div', { class: 'daysep', text: day })); lastDay = day }
    const cb = el('input', { type: 'checkbox', checked: !dup && !!c.url })
    rows.push({ cb, c, dup: !!dup })
    list.append(el('label', { class: 'cand' + (dup ? ' dup' : '') },
      cb,
      el('span', {},
        el('strong', { text: c.title }),
        el('span', { class: 'meta', text: `${fmtTime(c.start)} · ${c.venue || 'venue unknown'}${c.source ? ' · via ' + c.source : ''}${dup ? ' · already listed' : ''}` }),
        c.url ? el('a', { class: 'src', href: c.url, target: '_blank', rel: 'noopener', text: sourceLabel(c.url) })
              : el('span', { class: 'warn', text: 'no source URL - will not be published' }),
      ),
    ))
  }

  const msg = el('p', { class: 'dim' })
  const setAll = (on) => { for (const r of rows) if (r.c.url && !(on && r.dup)) r.cb.checked = on }
  const publishable = rows.filter(r => r.c.url && !r.dup).length

  openSheet(
    el('h2', { text: run.candidates.length
      ? `${run.candidates.length} candidates for ${run.city}`
      : `Nothing new found for ${run.city}` }),
    el('p', { class: 'dim', text:
      `${run.calls.length} calls over ${run.sources.length} ${run.sources.length === 1 ? 'catalogue' : 'catalogues'} · ` +
      `${usd(run.costUsd)} of ${usd(run.budgetUsd)} · stopped: ${run.stoppedBecause}` +
      (dupCount ? ` · ${dupCount} already listed, unticked` : '') }),
    el('p', { class: 'runsrc dim', text: 'new/found per catalogue: ' + run.calls.filter(c => c.found !== undefined)
      .map(c => `${c.label} ${c.added}/${c.found}`).join(' · ') }),
    run.candidates.length ? el('p', {},
      el('button', { class: 'ghost', text: `tick all (${publishable})`, onclick: () => setAll(true) }),
      el('button', { class: 'ghost', text: 'untick all', onclick: () => setAll(false) }),
    ) : null,
    list,
    el('p', {}, el('button', {
      class: 'primary',
      text: run.candidates.length ? 'publish the ticked ones' : 'close',
      onclick: async (ev) => {
        if (!run.candidates.length) { $('sheet').close(); return }
        ev.target.disabled = true
        await publishCandidates(run, rows.filter(r => r.cb.checked && r.c.url).map(r => r.c), msg)
      },
    })),
    msg,
  )
}

// Publishing a whole catalogue is a different scale from publishing four
// events: geocoding is memoised per venue and capped so a run of 90 events does
// not fire 90 requests at a free public geocoder, and relay writes run a few at
// a time instead of one after another.
async function publishCandidates(run, picked, msg) {
  const geocode = makeGeocoder({ enabled: !ppq.mock })
  let ok = 0, failed = 0
  msg.textContent = `publishing 0/${picked.length}…`
  await inPool(picked, 4, async (c) => {
    try {
      const signed = await candidateToEvent(state.identity, c, { city: run.city, lat: run.lat, lon: run.lon, tz: run.tz, geocode })
      await publish(signed)
      ok++
    } catch (err) { failed++; console.error('publish failed', c.title, err) }
    msg.textContent = `publishing ${ok + failed}/${picked.length}…`
  })

  // The catalogues this run walked are worth more than the events: they turn the
  // next visitor's first call into a harvest instead of a search. What gets
  // published is the page that actually held events - the dated listing, not the
  // section front page the search engine offers - so nobody pays again to find
  // the way from one to the other.
  const registry = new Map()
  for (const s of [...(run.discovered || []), ...(run.productive || [])]) if (s?.url) registry.set(s.url, s)
  if (registry.size) {
    try { await publishSources(state.identity, [...registry.values()].slice(0, 12), { city: run.city, lat: run.lat, lon: run.lon }) }
    catch (err) { console.warn('source registry publish failed', err) }
  }
  try { await publish(await scoutRunEvent(state.identity, run, ok)) }
  catch (err) { console.error('scout run record failed', err) }

  msg.textContent = `Published ${ok}${failed ? `, ${failed} failed` : ''}. Everyone reading ${run.city} now sees them.`
  $('sheet').close()
  await load()
}

async function inPool(items, width, fn) {
  let i = 0
  const worker = async () => { while (i < items.length) await fn(items[i++]) }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
}

async function openTopupSheet(acc) {
  const msg = el('p', { class: 'dim', text: 'Your PPQ balance is empty. Top up over Lightning - the minimum is 10 cents.' })
  const box = el('div')
  const amountButtons = [0.1, 1, 5].map(v => el('button', {
    class: 'ghost', text: usd(v), onclick: () => makeInvoice(v),
  }))
  openSheet(
    el('h2', { text: 'Top up to scout' }),
    msg,
    el('p', {}, ...amountButtons),
    box,
    acc?.creditId ? el('p', { class: 'dim' },
      el('span', { text: 'Your credit id is ' }),
      el('code', { class: 'mono', text: acc.creditId }),
      el('span', { text: ' - save it, and you can keep using the same balance at ' }),
      el('a', { href: ppq.sessionUrl(acc.creditId), target: '_blank', rel: 'noopener', text: 'ppq.ai' }),
      el('span', { text: '.' }),
    ) : null,
  )

  async function makeInvoice(usdAmount) {
    box.replaceChildren(el('p', { class: 'dim', text: 'asking PPQ for an invoice…' }))
    try {
      const inv = await ppq.createLightningTopup(acc, usdAmount)
      const bolt11 = inv.lightning_invoice || inv.invoice || ''
      box.replaceChildren(
        el('p', { text: `${usd(usdAmount)} ≈ ${satsFromBtc(inv.crypto_amount_due)} sat` }),
        bolt11 ? qrNode(bolt11.toUpperCase()) : null,
        el('code', { class: 'mono bolt', text: bolt11 }),
        el('p', {},
          el('button', { class: 'ghost', text: 'copy invoice', onclick: () => navigator.clipboard?.writeText(bolt11) }),
          bolt11 ? el('a', { class: 'ghost', href: 'lightning:' + bolt11, text: 'open in wallet' }) : null,
          inv.checkout_url ? el('a', { class: 'ghost', href: inv.checkout_url, target: '_blank', rel: 'noopener', text: 'other coins →' }) : null,
        ),
        el('p', { class: 'dim', id: 'payst', text: 'waiting for payment…' }),
      )
      const id = inv.invoice_id || inv.id
      const started = Date.now()
      const poll = setInterval(async () => {
        if (Date.now() - started > 16 * 60 * 1000) { clearInterval(poll); return }
        try {
          const st = await ppq.topupStatus(acc, id)
          if (String(st.status).toLowerCase().startsWith('paid') || Number(st.amount_paid) > 0) {
            clearInterval(poll)
            state.balance = await ppq.getBalance(acc)
            renderRunInfo()
            showPaid(acc)
          }
        } catch (err) { /* keep polling until the invoice expires */ }
      }, 4000)
    } catch (err) {
      box.replaceChildren(el('p', { class: 'warn', text: 'PPQ refused the top-up: ' + err.message }))
    }
  }
}

// Paying is the one moment in this page where someone parted with money on
// trust. It gets an answer you cannot miss, and a button that spends it.
function showPaid(acc) {
  const place = currentPlace()
  const rate = eventsPerDollar()
  openSheet(
    el('p', { class: 'paid' }, el('span', { class: 'tick', text: '✓' })),
    el('h2', { class: 'center', text: 'Paid' }),
    el('p', { class: 'center big', text: usd(state.balance) + ' on your PPQ credit' }),
    el('p', { class: 'center dim', text: rate
      ? `Enough for roughly ${Math.round(rate * state.balance)} events at what ${place.name} has cost so far.`
      : 'Enough for several catalogue passes.' }),
    el('p', { class: 'center' },
      el('button', {
        class: 'primary',
        text: `Scout ${place.name} now`,
        onclick: () => { $('sheet').close(); onScout() },
      }),
    ),
    acc?.creditId ? el('p', { class: 'center dim' },
      el('span', { text: 'Leftover credit is yours: ' }),
      el('a', { href: ppq.sessionUrl(acc.creditId), target: '_blank', rel: 'noopener', text: 'continue at ppq.ai' }),
      el('span', { text: ' with the same credit id.' }),
    ) : null,
  )
  confettiBurst($('sheet'))
}

function confettiBurst(host) {
  if (!host || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const colours = ['#ffb545', '#ff6b6b', '#5ad1a0', '#63a9ff', '#f4efe8', '#c792ea']
  const wrap = el('div', { class: 'confetti', 'aria-hidden': 'true' })
  for (let i = 0; i < 80; i++) {
    const p = document.createElement('i')
    p.style.left = (Math.random() * 100).toFixed(1) + '%'
    p.style.background = colours[i % colours.length]
    p.style.setProperty('--x', (Math.random() * 60 - 30).toFixed(1) + 'vw')
    p.style.setProperty('--r', Math.round(Math.random() * 1080 - 540) + 'deg')
    p.style.setProperty('--d', (1.1 + Math.random() * 1.1).toFixed(2) + 's')
    p.style.setProperty('--delay', (Math.random() * 0.45).toFixed(2) + 's')
    p.style.width = (4 + Math.random() * 5).toFixed(1) + 'px'
    p.style.height = (7 + Math.random() * 7).toFixed(1) + 'px'
    wrap.append(p)
  }
  host.append(wrap)
  setTimeout(() => wrap.remove(), 3500)
}

// Lightning invoices are meant to be scanned: the phone in your hand is rarely
// the device holding the wallet.
function qrNode(text) {
  const qr = qrcode(0, 'L')
  qr.addData(text)
  qr.make()
  const wrap = el('div', { class: 'qr' })
  wrap.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  return wrap
}

// ---------- city search ----------

function wireCitySearch() {
  const input = $('cityq')
  const sugg = $('suggest')
  let timer = null
  input.addEventListener('input', () => {
    clearTimeout(timer)
    const q = input.value.trim()
    if (q.length < 2) { sugg.hidden = true; return }
    timer = setTimeout(async () => {
      try {
        const hits = await geocodeCity(q)
        sugg.replaceChildren(...hits.slice(0, 6).map(h => el('button', {
          class: 'sugg',
          text: `${h.name}${h.state ? ', ' + h.state : ''}${h.country ? ' (' + h.country + ')' : ''}`,
          onclick: async () => {
            state.cities.push({ name: h.name, country: h.country, lat: h.lat, lon: h.lon })
            state.active = state.cities.length - 1
            state.usingNear = false
            saveCities(); syncUrl()
            input.value = ''; sugg.hidden = true
            renderCities()
            await load()
          },
        })))
        sugg.hidden = hits.length === 0
      } catch { sugg.hidden = true }
    }, 250)
  })
  $('addcity').addEventListener('submit', (e) => e.preventDefault())
}

// ---------- boot ----------

async function main() {
  if (new URLSearchParams(location.search).has('mock')) ppq = mockPpq()
  loadCities()
  state.identity = await getIdentity()
  const acc = ppq.storedAccount()
  if (acc) { try { state.balance = await ppq.getBalance(acc) } catch { /* offline is fine */ } }
  renderCities(); renderWhen(); renderIdent(); renderRunInfo()
  wireCitySearch()
  $('scout').addEventListener('click', onScout)
  $('settings-open').addEventListener('click', openSettingsSheet)
  syncUrl()
  await load()
}

if (typeof document !== 'undefined' && !window.__TONIGHT_NO_BOOT) main().catch(err => {
  console.error(err)
  setStatus('Something broke: ' + err.message)
})
