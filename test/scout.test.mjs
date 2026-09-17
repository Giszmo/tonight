import assert from 'node:assert/strict'
import {
  parseCandidates, parseHarvest, parseSources, buildHarvestMessages, buildSourceMessages,
  findDuplicate, runScout, makeGeocoder, zonedToSeconds, validZone,
} from '../src/scout.js'
import { InsufficientBalance } from '../src/ppq.js'

// ---------- parsing ----------

// the model wraps JSON in a fence more often than not
const fenced = '```json\n{"events":[{"title":"Kammerkonzert","start":"2026-09-20T20:00","end":null,"venue":"Gasteig HP8","address":"Hans-Preissinger-Str. 8","category":"concert","summary":"Streichquartett","url":"https://gasteig.de/x"}]}\n```'
let c = parseCandidates(fenced)
assert.equal(c.length, 1)
assert.equal(c[0].title, 'Kammerkonzert')
assert.equal(c[0].start, Math.floor(Date.parse('2026-09-20T20:00') / 1000))
assert.equal(c[0].end, null)

// prose before the object, bare array, junk entries
c = parseCandidates('Here you go:\n{"events":[{"title":"A","start":"2026-09-20T20:00","url":"not-a-url"},{"title":"","start":"2026-09-20T21:00"},{"nope":1}]}')
assert.equal(c.length, 1, 'entries without a title are dropped')
assert.equal(c[0].url, '', 'a non-URL source is dropped, not published')

c = parseCandidates('[{"title":"B","start":1789200000,"venue":"X"}]')
assert.equal(c.length, 1)
assert.equal(c[0].start, 1789200000)

assert.throws(() => parseCandidates('sorry, I could not find anything'), /did not return JSON/)

// pagination signals drive a second pass over the same catalogue
const h = parseHarvest('{"events":[{"title":"A","start":"2026-09-20T20:00"}],"more":true,"covered_until":"2026-09-22T00:00"}')
assert.equal(h.more, true)
assert.equal(h.coveredUntil, Math.floor(Date.parse('2026-09-22T00:00') / 1000))
assert.equal(parseHarvest('{"events":[]}').more, false)

// The city's wall clock is not the visitor's. A model that names the zone gets
// its times read in that zone, whatever the browser is set to.
const berlin = parseHarvest('{"tz":"Europe/Berlin","events":[{"title":"Konzert","start":"2026-01-15T20:00"}]}')
assert.equal(berlin.tz, 'Europe/Berlin')
assert.equal(berlin.candidates[0].start, Math.floor(Date.parse('2026-01-15T19:00:00Z') / 1000), 'CET is UTC+1')
const summer = parseHarvest('{"tz":"Europe/Berlin","events":[{"title":"Konzert","start":"2026-07-15T20:00"}]}')
assert.equal(summer.candidates[0].start, Math.floor(Date.parse('2026-07-15T18:00:00Z') / 1000), 'CEST is UTC+2')
assert.equal(zonedToSeconds('2026-07-15T20:00', 'America/Mexico_City'), Math.floor(Date.parse('2026-07-16T02:00:00Z') / 1000))
assert.equal(validZone('Not/AZone'), null)
assert.equal(parseHarvest('{"tz":"Not/AZone","events":[{"title":"X","start":"2026-07-15T20:00"}]}').tz, null,
  'a bogus zone is ignored rather than trusted')
// an explicit offset in the timestamp wins over any zone
assert.equal(parseHarvest('{"tz":"Europe/Berlin","events":[{"title":"X","start":"2026-07-15T20:00:00Z"}]}').candidates[0].start,
  Math.floor(Date.parse('2026-07-15T20:00:00Z') / 1000))

// ---------- catalogue discovery ----------

const sources = parseSources(JSON.stringify({
  sources: [
    { name: 'in München', url: 'https://www.in-muenchen.de/veranstaltungen', kind: 'magazine' },
    { name: 'in München (again)', url: 'https://in-muenchen.de/heute', kind: 'magazine' },
    { name: 'no url', kind: 'city' },
    { name: 'München Ticket', url: 'https://www.muenchenticket.de/events', kind: 'tickets' },
  ],
}))
assert.equal(sources.length, 2, 'one entry per host, entries without a URL dropped')
assert.deepEqual(sources.map(s => s.kind), ['magazine', 'tickets'])
assert.match(buildSourceMessages({ city: 'Traunstein', country: 'Germany' })[1].content, /Traunstein, Germany/)
const expand = buildSourceMessages({ city: 'München', exclude: [{ url: 'https://www.in-muenchen.de/x' }] })[1].content
assert.match(expand, /already know these.*in-muenchen\.de/s, 'an expansion search asks for catalogues we do not have')

// ---------- prompts ----------

const known = [{ start: 1789200000, title: 'Already there', venue: 'Volkstheater' }]
let msgs = buildHarvestMessages({ city: 'Traunstein', country: 'Germany', from: 1789200000, to: 1789286400, known })
assert.match(msgs[1].content, /Traunstein, Germany/)
assert.match(msgs[1].content, /Already there @ Volkstheater/, 'known events are listed so the run does not re-find them')
assert.match(msgs[1].content, /event listings for Traunstein/, 'no source given means an open search')

msgs = buildHarvestMessages({
  city: 'München', from: 1789200000, to: 1789286400, page: 2, after: 1789250000,
  source: { name: 'in München', url: 'https://in-muenchen.de/x' },
})
assert.match(msgs[1].content, /https:\/\/in-muenchen\.de\/x/)
assert.match(msgs[1].content, /This is pass 2/, 'a second pass tells the model where it got to')

// ---------- dedup against what is already published ----------

const published = [{
  id: 'x', d: '', address: '', title: 'Münchner Kammerorchester: Schubert', venue: 'Prinzregententheater',
  start: 1789200000, end: null, coords: null, refs: [], image: '', summary: '', createdAt: 1, hashtags: [],
}]
assert.ok(findDuplicate({ title: 'Kammerorchester München - Schubert (Prinzregententheater)', venue: 'Prinzregententheater München', start: 1789200300 }, published),
  'a candidate already on the relays is recognised through the real matcher')
assert.equal(findDuplicate({ title: 'Rammstein', venue: 'Olympiahalle', start: 1789200000 }, published), null)

// ---------- the run ----------

const FROM = Math.floor(Date.parse('2026-09-20T12:00:00Z') / 1000)
const TO = FROM + 5 * 86400
const ev = (title, dayOffset = 0, venue = 'Hall') =>
  ({ title, start: new Date((FROM + dayOffset * 86400) * 1000).toISOString().slice(0, 16), venue, url: 'https://x.test/' + encodeURIComponent(title), category: 'concert' })
// the fake catalogues quote UTC and say so, the way a real answer carries its zone
const harvest = (events, more = false) => JSON.stringify({ tz: 'UTC', events, more })

function fakeApi({ balance = 1, perCall = 0.02, answer }) {
  let b = balance
  const seen = []
  return {
    InsufficientBalance,
    seen,
    getBalance: async () => b,
    chat: async (_acc, { messages }) => {
      const prompt = messages.map(m => m.content).join('\n')
      seen.push(prompt)
      if (b <= 0) throw new InsufficientBalance()
      b = +(b - perCall).toFixed(5)
      return { text: answer(prompt, seen.length), model: 'fake-model:online' }
    },
  }
}

const CATALOGUES = JSON.stringify({ sources: [
  { name: 'One', url: 'https://one.test/events', kind: 'magazine' },
  { name: 'Two', url: 'https://two.test/events', kind: 'tickets' },
] })

// a full run: catalogues, both of them walked, one paginated, duplicates dropped
let run = await runScout({}, {
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1, api: fakeApi({
    answer: (prompt) => {
      if (/List the web pages that catalogue/.test(prompt)) return CATALOGUES
      if (prompt.includes('one.test')) {
        return /This is pass 2/.test(prompt)
          ? harvest([ev('Later Show', 3)])
          : harvest([ev('Opening Night'), ev('Shared Gala', 1)], true)
      }
      if (prompt.includes('two.test')) return harvest([ev('Shared Gala', 1), ev('Ticketed Show', 2)])
      return harvest([ev('Found By Search', 4)])
    },
  }),
})
assert.deepEqual(run.candidates.map(c => c.title),
  ['Opening Night', 'Shared Gala', 'Ticketed Show', 'Later Show', 'Found By Search'],
  'every catalogue is walked, the paginated one twice, and the open search closes the gap')
assert.equal(run.candidates.filter(c => c.title === 'Shared Gala').length, 1,
  'the same event from two catalogues collapses inside one run')
assert.equal(run.calls.length, 5, 'catalogues + one.test x2 + two.test + open search')
assert.equal(run.costUsd, 0.1, 'cost is the measured balance delta over every call')
assert.equal(run.stoppedBecause, 'window covered')
assert.equal(run.sources.length, 2)

// events the city already has are not re-collected even if a catalogue lists them
run = await runScout({}, {
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1,
  known: [{ title: 'Opening Night', venue: 'Hall', start: FROM, coords: null, refs: [], address: '', d: '' }],
  sources: [{ url: 'https://one.test/events', name: 'One' }],
  api: fakeApi({ answer: () => harvest([ev('Opening Night'), ev('Something Else', 1)]) }),
})
assert.deepEqual(run.candidates.map(c => c.title), ['Something Else'],
  'an event already on the relays is filtered out of the candidates')
assert.ok(run.calls.every(c => c.label !== 'catalogues'), 'a known source list skips the discovery call')

// the budget is a hard stop: no call is made that could cross it
run = await runScout({}, {
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 0.05,
  api: fakeApi({ answer: (p) => /catalogue in/.test(p) ? CATALOGUES : CATALOGUES }),
})
assert.equal(run.calls.length, 2, 'two calls at 2 cents fit under 5 cents, a third would not')
assert.ok(run.costUsd <= 0.05, 'a run never spends more than the budget: ' + run.costUsd)
assert.equal(run.stoppedBecause, 'budget spent')

// the budget can never exceed the balance
run = await runScout({}, {
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 10,
  api: fakeApi({ balance: 0.05, answer: () => harvest([]) }),
})
assert.equal(run.budgetUsd, 0.05)

// stopping mid-run is honoured
let n = 0
run = await runScout({}, {
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1,
  api: fakeApi({ answer: () => { n++; return CATALOGUES } }),
  shouldStop: () => n >= 2,
})
assert.equal(run.stoppedBecause, 'stopped by you')

// no money, no call
await assert.rejects(
  runScout({}, { city: 'Testheim', from: FROM, to: TO, api: fakeApi({ balance: 0, answer: () => '' }) }),
  (err) => err instanceof InsufficientBalance)

// a catalogue that answers with junk does not kill the run
run = await runScout({}, {
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1,
  sources: [{ url: 'https://one.test/events' }, { url: 'https://two.test/events' }],
  api: fakeApi({ answer: (p) => p.includes('one.test') ? 'sorry, nothing found' : harvest([ev('Survivor')]) }),
})
assert.deepEqual(run.candidates.map(c => c.title), ['Survivor'], 'one bad answer does not end the run')

// events outside the asked window are dropped even if the model returns them
run = await runScout({}, {
  city: 'Testheim', from: FROM, to: FROM + 86400, budgetUsd: 1,
  sources: [{ url: 'https://one.test/events' }],
  api: fakeApi({ answer: () => harvest([ev('In Window'), ev('Next Week', 7)]) }),
})
assert.deepEqual(run.candidates.map(c => c.title), ['In Window'])

// ---------- the catalogue registry ----------

// Known sources come from nostr, so a normal run pays for events only...
const registry = [{ url: 'https://one.test/events', name: 'One' }]
run = await runScout({}, {
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1, sources: registry,
  api: fakeApi({ answer: () => harvest([ev('From The Registry')]) }),
})
assert.ok(!run.calls.some(c => c.label === 'catalogues'), 'a populated registry skips the search')
assert.equal(run.discovered.length, 0, 'nothing new to publish')

// ...and an occasional run asks for catalogues beyond the ones nostr has.
run = await runScout({}, {
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1, sources: registry, discover: 'always',
  api: fakeApi({
    answer: (p) => /List the web pages that catalogue/.test(p)
      ? JSON.stringify({ sources: [{ name: 'One', url: 'https://one.test/events' }, { name: 'Three', url: 'https://three.test/events' }] })
      : harvest([ev('Anything ' + (p.match(/https:\/\/(\w+)\.test/) || [])[1])]),
  }),
})
assert.deepEqual(run.discovered.map(s => s.name), ['Three'], 'only genuinely new catalogues are published back')
assert.deepEqual(run.sources.map(s => s.name), ['Three', 'One'], 'the unexplored one is walked first')
assert.ok(run.calls.some(c => c.label === 'three.test'), 'the new catalogue is actually read in the same run')

// ---------- geocoding budget ----------

let lookups = 0
const geocode = makeGeocoder({ limit: 2, lookup: async () => { lookups++; return { lat: 1, lon: 2 } } })
await geocode('Gasteig', 'München')
await geocode('Gasteig', 'München')
await geocode('Volkstheater', 'München')
await geocode('Blitz', 'München')
assert.equal(lookups, 2, 'venues are memoised and the total is capped')
assert.equal(await makeGeocoder({ enabled: false })('Gasteig', 'München'), null)

console.log('scout tests ok')
