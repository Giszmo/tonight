import assert from 'node:assert/strict'
import {
  parseCandidates, parseHarvest, parseSources, buildHarvestMessages, buildSourceMessages, SOURCE_ANGLES,
  repairTruncatedJson,
  findDuplicate, runScout, makeGeocoder, zonedToSeconds, validZone, shortUrl,
  missingAngles, pageOf, dayZoneForLongitude,
} from '../src/scout.js'
import { htmlToText, readPage, PageUnavailable, SLICE_CHARS } from '../src/reader.js'
import { InsufficientBalance, keyName, KEY_NAME_MAX, getBalance } from '../src/ppq.js'
import { isDatedUrl } from '../src/main.js'

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

// An answer cut off by the output limit is a short answer, not a lost one: the
// whole events array up to the last complete entry is still good, and that call
// has already been paid for.
const truncated = '{"tz":"Europe/Berlin","events":[' +
  '{"title":"Whole One","start":"2026-07-15T20:00","venue":"Kino"},' +
  '{"title":"Whole Two","start":"2026-07-15T21:00","venue":"Kino, \\"Saal 2\\""},' +
  '{"title":"Cut off here","start":"2026-07-15T2'
const salvaged = parseHarvest(truncated)
assert.deepEqual(salvaged.candidates.map(c => c.title), ['Whole One', 'Whole Two'],
  'complete events survive a truncated answer')
assert.equal(salvaged.tz, 'Europe/Berlin')
assert.equal(repairTruncatedJson('{"events":[{"a":1}]}'), null, 'a complete answer is not "repaired"')
assert.equal(repairTruncatedJson('sorry, nothing found'), null)
assert.equal(repairTruncatedJson('{"events":[{"a":'), null, 'nothing whole to keep')
assert.throws(() => parseHarvest('sorry, nothing found'), /did not return JSON/)

// ---------- catalogue discovery ----------

// A host may contribute a few pages - a portal's today view and its calendar,
// or one page per cinema - but not a whole site, and the same page twice is
// still one page.
const sources = parseSources(JSON.stringify({
  sources: [
    { name: 'in München', url: 'https://www.in-muenchen.de/veranstaltungen', kind: 'magazine' },
    { name: 'in München (again)', url: 'https://in-muenchen.de/heute', kind: 'magazine' },
    { name: 'no url', kind: 'city' },
    { name: 'München Ticket', url: 'https://www.muenchenticket.de/events', kind: 'tickets' },
    { name: 'same page, trailing slash', url: 'https://www.in-muenchen.de/veranstaltungen/', kind: 'magazine' },
    { name: 'a fourth on that host', url: 'https://in-muenchen.de/kino', kind: 'magazine' },
    { name: 'a fifth on that host', url: 'https://in-muenchen.de/konzerte', kind: 'magazine' },
  ],
}))
assert.deepEqual(sources.map(s => s.url), [
  'https://www.in-muenchen.de/veranstaltungen',
  'https://in-muenchen.de/heute',
  'https://www.muenchenticket.de/events',
  'https://in-muenchen.de/kino',
], 'up to three pages per host, no duplicate URL, nothing without one')
assert.equal(parseSources(JSON.stringify({ sources: [
  { url: 'https://a.test/1' }, { url: 'https://a.test/2' },
] }), { perHost: 1 }).length, 1, 'the per-host cap is settable')

assert.match(buildSourceMessages({ city: 'Traunstein', country: 'Germany' })[1].content, /Traunstein, Germany/)
// What we already have is a page, not a site. Excluding the host is how a run
// that held muenchen.de's front listing asked for "other" catalogues and so
// ruled out muenchen.de's own today view, the one page with the day on it.
const expand = buildSourceMessages({
  city: 'München',
  exclude: [{ url: 'https://www.muenchen.de/veranstaltungen/events?x=1' }],
})[1].content
assert.match(expand, /muenchen\.de\/veranstaltungen\/events/, 'the known page is named in full')
assert.doesNotMatch(expand, /muenchen\.de\/veranstaltungen\/events\?/, 'without its query string')
assert.match(expand, /same site is welcome/, 'another listing on a known host is still wanted')
assert.equal(pageOf('https://www.muenchen.de/veranstaltungen/event/heute/'), 'muenchen.de/veranstaltungen/event/heute')

// A registry that grew out of one run answers only for the kinds that run asked
// about. Munich's nine catalogues had no film programme in them at all, so no
// budget could buy a cinema: the gap has to be visible as a gap.
const munichRegistry = [
  { url: 'https://muenchen.de/veranstaltungen/events', kind: 'city' },
  { url: 'https://in-muenchen.de/veranstaltungen', kind: 'magazine' },
  { url: 'https://gasteig.de/veranstaltungen', kind: 'venue' },
]
assert.deepEqual(missingAngles(munichRegistry).map(a => a.key), ['cinema', 'tickets'])
assert.deepEqual(missingAngles([...munichRegistry, { url: 'https://kino.de/m', kind: 'cinema' }]).map(a => a.key),
  ['tickets'])
assert.equal(missingAngles([]).length, SOURCE_ANGLES.length, 'an empty registry is missing everything')
assert.equal(missingAngles([{ url: 'https://x.de', kind: 'university' }]).map(a => a.key).includes('venues'), false,
  'a university calendar counts as a venue programme')

// Discovery is several narrow searches, not one broad one: the broad form finds
// an expat blog and one arthouse cinema, the cinema angle finds the city's film
// programme. Each angle has to reach the model as its own question.
assert.ok(SOURCE_ANGLES.length >= 3, 'several angles')
const angled = SOURCE_ANGLES.map(a => buildSourceMessages({ city: 'München', angle: a })[1].content)
assert.equal(new Set(angled).size, SOURCE_ANGLES.length, 'every angle asks a different question')
assert.match(angled[SOURCE_ANGLES.findIndex(a => a.key === 'cinema')], /Kinoprogramm München heute/,
  'the cinema angle is phrased in the local language, with the city substituted')

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

// No test reaches the network: a run that cannot fetch a catalogue falls back
// to asking the model, which is exactly the pre-existing behaviour these cases
// were written against.
const offline = async () => { throw new PageUnavailable('x', 'offline') }

function fakeApi({ balance = 1, perCall = 0.02, answer }) {
  let b = balance
  const seen = []
  const api = {
    InsufficientBalance,
    seen,
    getBalance: async () => b,
    opts: [],
    chat: async (_acc, { messages, search = true }) => {
      const prompt = messages.map(m => m.content).join('\n')
      seen.push(prompt)
      api.opts.push({ search })
      if (b <= 0) throw new InsufficientBalance()
      b = +(b - perCall).toFixed(5)
      return { text: answer(prompt, seen.length), model: 'fake-model:online' }
    },
  }
  return api
}

const CATALOGUES = JSON.stringify({ sources: [
  { name: 'One', url: 'https://one.test/events', kind: 'magazine' },
  { name: 'Two', url: 'https://two.test/events', kind: 'tickets' },
] })

// a full run: catalogues, both of them walked, one paginated, duplicates dropped
let run = await runScout({}, { fetchPage: offline,
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
const harvestCalls = run.calls.filter(c => !c.label.startsWith('catalogues'))
assert.deepEqual(harvestCalls.map(c => c.label),
  ['one.test/events', 'two.test/events', 'one.test/events', 'open web'],
  'one.test is walked twice, two.test once, and the open search runs last')
const angleCalls = run.calls.filter(c => c.label.startsWith('catalogues')).map(c => c.label.split(':')[1])
assert.deepEqual(angleCalls.slice(0, SOURCE_ANGLES.length), SOURCE_ANGLES.map(a => a.key),
  'each angle is its own search')
// The unspent budget buys another round, and that round goes after the kinds
// this city still has nothing for rather than asking all four again.
const secondRound = angleCalls.slice(SOURCE_ANGLES.length)
assert.ok(secondRound.length > 0, 'the leftover budget buys a second round')
assert.ok(secondRound.length < SOURCE_ANGLES.length, 'and it is narrower than the first')
assert.equal(new Set(secondRound).size, secondRound.length, 'no angle is asked twice in one round')
assert.equal(run.costUsd, +(run.calls.length * 0.02).toFixed(5), 'cost is the measured balance delta over every call')
assert.equal(run.stoppedBecause, 'window covered')
assert.equal(run.sources.length, 2)

// events the city already has are not re-collected even if a catalogue lists them
run = await runScout({}, { fetchPage: offline,
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1,
  known: [{ title: 'Opening Night', venue: 'Hall', start: FROM, coords: null, refs: [], address: '', d: '' }],
  sources: [{ url: 'https://one.test/events', name: 'One' }],
  api: fakeApi({ answer: () => harvest([ev('Opening Night'), ev('Something Else', 1)]) }),
})
assert.deepEqual(run.candidates.map(c => c.title), ['Something Else'],
  'an event already on the relays is filtered out of the candidates')
assert.ok(run.calls.every(c => c.label !== 'catalogues'), 'a known source list skips the discovery call')

// the budget is a hard stop: no call is made that could cross it
run = await runScout({}, { fetchPage: offline,
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 0.05,
  api: fakeApi({ answer: (p) => /catalogue in/.test(p) ? CATALOGUES : CATALOGUES }),
})
assert.equal(run.calls.length, 2, 'two calls at 2 cents fit under 5 cents, a third would not')
assert.ok(run.costUsd <= 0.05, 'a run never spends more than the budget: ' + run.costUsd)
assert.equal(run.stoppedBecause, 'budget spent')

// the budget can never exceed the balance
run = await runScout({}, { fetchPage: offline,
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 10,
  api: fakeApi({ balance: 0.05, answer: () => harvest([]) }),
})
assert.equal(run.budgetUsd, 0.05)

// stopping mid-run is honoured
let n = 0
run = await runScout({}, { fetchPage: offline,
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1,
  api: fakeApi({ answer: () => { n++; return CATALOGUES } }),
  shouldStop: () => n >= 2,
})
assert.equal(run.stoppedBecause, 'stopped by you')

// no money, no call
await assert.rejects(
  runScout({}, { fetchPage: offline, city: 'Testheim', from: FROM, to: TO, api: fakeApi({ balance: 0, answer: () => '' }) }),
  (err) => err instanceof InsufficientBalance)

// a catalogue that answers with junk does not kill the run
run = await runScout({}, { fetchPage: offline,
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1,
  sources: [{ url: 'https://one.test/events' }, { url: 'https://two.test/events' }],
  api: fakeApi({ answer: (p) => p.includes('one.test') ? 'sorry, nothing found' : harvest([ev('Survivor')]) }),
})
assert.deepEqual(run.candidates.map(c => c.title), ['Survivor'], 'one bad answer does not end the run')

// events outside the asked window are dropped even if the model returns them
run = await runScout({}, { fetchPage: offline,
  city: 'Testheim', from: FROM, to: FROM + 86400, budgetUsd: 1,
  sources: [{ url: 'https://one.test/events' }],
  api: fakeApi({ answer: () => harvest([ev('In Window'), ev('Next Week', 7)]) }),
})
assert.deepEqual(run.candidates.map(c => c.title), ['In Window'])

// ---------- the catalogue registry ----------

// Known sources come from nostr, so a normal run pays for events only...
const registry = [{ url: 'https://one.test/events', name: 'One' }]
run = await runScout({}, { fetchPage: offline,
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1, sources: registry,
  api: fakeApi({ answer: () => harvest([ev('From The Registry')]) }),
})
assert.ok(!run.calls.some(c => c.label.startsWith('catalogues')), 'a populated registry skips the search')
assert.equal(run.discovered.length, 0, 'nothing new to publish')

// ...and an occasional run asks for catalogues beyond the ones nostr has.
run = await runScout({}, { fetchPage: offline,
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1, sources: registry, discover: 'always',
  api: fakeApi({
    answer: (p) => /List the web pages that catalogue/.test(p)
      ? JSON.stringify({ sources: [{ name: 'One', url: 'https://one.test/events' }, { name: 'Three', url: 'https://three.test/events' }] })
      : harvest([ev('Anything ' + (p.match(/https:\/\/(\w+)\.test/) || [])[1])]),
  }),
})
assert.deepEqual(run.discovered.map(s => s.name), ['Three'], 'only genuinely new catalogues are published back')
assert.deepEqual(run.sources.map(s => s.name), ['Three', 'One'], 'the unexplored one is walked first')
assert.ok(run.calls.some(c => c.label === 'three.test/events'), 'the new catalogue is actually read in the same run')

// A city whose registry covers some kinds and not others pays for the holes
// only. Munich's registry had a portal, a magazine and a concert hall in it and
// no film programme at all, and asking all four questions again would have
// bought three answers it already had.
const gapApi = fakeApi({
  answer: (p) => /List the web pages that catalogue/.test(p)
    ? JSON.stringify({ sources: [{ name: 'Kino', url: 'https://kino.test/heute', kind: 'cinema' }] })
    : harvest([ev('Film')]),
})
run = await runScout({}, { fetchPage: offline,
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1, discover: 'always',
  sources: [
    { url: 'https://one.test/events', name: 'One', kind: 'city' },
    { url: 'https://hall.test/programm', name: 'Hall', kind: 'venue' },
  ],
  api: gapApi,
})
// (a later round can still ask everything: once the queue is empty and the
// money is not, the run is out of places to look, not short of one kind)
const asked = run.calls.filter(c => c.label.startsWith('catalogues:')).map(c => c.label.slice('catalogues:'.length))
assert.deepEqual(asked.slice(0, 2).sort(), ['cinema', 'tickets'],
  'the first round searches only for the kinds the city has nothing for')
assert.ok(run.calls.some(c => c.label === 'kino.test/heute'), 'and the film programme it found is read')

// A film page that renders its showtimes in the browser reads as an empty page
// here. Publishing it as the city's cinema catalogue would mark the gap filled
// for every later run, so an empty page is reported as barren and the run goes
// back out for another one while it can still afford to read it.
const cinemaPages = []
run = await runScout({}, { fetchPage: offline,
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 2, discover: 'always',
  sources: [{ url: 'https://one.test/events', name: 'One', kind: 'city' }],
  api: fakeApi({ answer: (p) => {
    if (/List the web pages that catalogue/.test(p)) {
      if (!/cinema|film|showtimes|Kinoprogramm/i.test(p)) return JSON.stringify({ sources: [] })
      cinemaPages.push(1)
      return JSON.stringify({ sources: cinemaPages.length === 1
        ? [{ name: 'Dead', url: 'https://dead.test/kino', kind: 'cinema' }]
        : [{ name: 'Live', url: 'https://live.test/kino', kind: 'cinema' }] })
    }
    return /dead\.test/.test(p) ? harvest([]) : harvest([ev('Film Showing')])
  } }),
})
assert.ok(run.barren.includes('https://dead.test/kino'), 'the page that held nothing is marked barren')
assert.equal(run.productive.some(s => s.url === 'https://dead.test/kino'), false,
  'and is not offered to the next visitor as a catalogue')
assert.ok(cinemaPages.length > 1, 'the cinema gap is searched for again rather than counted as filled')
assert.ok(run.candidates.some(c => c.title === 'Film Showing'), 'so the city gets its films')


// A run that walks out of catalogues with most of the money untouched has not
// covered the city, it has run out of places to look. Munich stopped at
// "window covered" having spent $0.04 of $0.25, so an idle budget buys another
// round of catalogue searches - excluding everything already tried.
let expansionAsks = 0
run = await runScout({}, { fetchPage: offline,
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1,
  api: fakeApi({ answer: (p) => {
    if (/List the web pages that catalogue/.test(p)) {
      if (!/already have these pages/.test(p)) return JSON.stringify({ sources: [{ name: 'One', url: 'https://one.test/events' }] })
      expansionAsks++
      assert.match(p, /already have these pages.*one\.test\/events/s, "the second round names what has been tried")
      return JSON.stringify({ sources: [{ name: 'Late', url: 'https://late.test/events' }] })
    }
    return harvest([ev('Show from ' + (p.match(/https:\/\/(\w+)\.test/) || [])[1])])
  } }),
})
assert.ok(expansionAsks > 0, 'the leftover budget went back out looking for catalogues')
assert.ok(run.calls.some(c => c.label === 'late.test/events'), 'and the catalogue it found was walked in the same run')
assert.ok(run.candidates.some(c => c.title === 'Show from late'), 'so its events are in the result')
assert.deepEqual(run.discovered.map(s => s.name), ['One', 'Late'], 'both rounds are published back to the registry')

// ...but a budget that is already mostly spent is not raided for another search.
run = await runScout({}, { fetchPage: offline,
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 0.14,
  api: fakeApi({ answer: (p) => /List the web pages that catalogue/.test(p)
    ? JSON.stringify({ sources: [{ name: 'One', url: 'https://one.test/events' }] })
    : harvest([ev('Only Show')]) }),
})
assert.equal(run.calls.filter(c => c.label.startsWith('catalogues')).length, SOURCE_ANGLES.length,
  'one round of searches only: ' + run.calls.map(c => c.label).join(', '))


// ---------- reading the page instead of searching for it ----------

// The bug this whole path exists for: a search-backed model never opens the
// listing. It answers from snippets, so a portal with forty-four events that
// day came back with one. When we hand it the page, the prompt must forbid
// everything except that page.
const page = buildHarvestMessages({
  city: 'München', from: FROM, to: TO,
  url: 'https://muenchen.test/veranstaltungen/heute',
  pageText: '* [Konzert](https://muenchen.test/k) — 2026-09-20 20:00 — Gasteig — concert',
})
assert.match(page[0].content, /extract public events from the page text/i)
assert.doesNotMatch(page[0].content, /search the web/i, 'extraction must not invite a web search')
assert.match(page[1].content, /Do not search, do not recall/)
assert.match(page[1].content, /--- page text of https:\/\/muenchen\.test\/veranstaltungen\/heute ---/)
assert.match(page[1].content, /listing_urls/, 'a hub can answer with the listings it points at')

// A daily programme prints a time and no date, so the prompt has to say which
// day "today" is - and it has to be the city's day, not Greenwich's. An evening
// in Los Angeles is already tomorrow in UTC, and the run does not know the real
// zone until the first answer comes back, so the day falls back to longitude.
assert.equal(dayZoneForLongitude(11.58), 'Etc/GMT-1')      // München, UTC+1/+2
assert.equal(dayZoneForLongitude(-118.24), 'Etc/GMT+8')    // Los Angeles
assert.equal(dayZoneForLongitude(0), 'UTC')
assert.equal(dayZoneForLongitude(undefined), null)

// 2026-09-21T02:00Z is still the evening of the 20th in Los Angeles.
const laEvening = Math.floor(Date.parse('2026-09-21T02:00:00Z') / 1000)
const la = buildHarvestMessages({
  city: 'Los Angeles', from: laEvening, to: laEvening + 21600,
  url: 'https://la.test/showtimes', pageText: '* Vaterland 18:45',
  tz: dayZoneForLongitude(-118.24),
})
assert.match(la[1].content, /Today is Sunday 2026-09-20 in Los Angeles/)

// Links the model reports are resolved against the page and kept only if they
// stay on it: a hub's "listings" routinely include a ticket shop's banner.
const links = parseHarvest(
  '{"events":[],"listing_urls":["/veranstaltungen/heute","https://ads.test/x"],"next_url":"?seite=2"}',
  { base: 'https://muenchen.test/veranstaltungen' })
assert.deepEqual(links.listingUrls, ['https://muenchen.test/veranstaltungen/heute'])
assert.equal(links.nextUrl, 'https://muenchen.test/veranstaltungen?seite=2')
assert.equal(parseHarvest('{"events":[],"next_url":"https://ads.test/x"}', { base: 'https://muenchen.test/a' }).nextUrl, '')

// A registry entry pointing at a section front page - which is what a search
// engine offers, and what the first Munich run got - has to be followed to the
// dated listing behind it, in the same run and without a second search.
const HUB = 'https://muenchen.test/veranstaltungen'
const LIST = 'https://muenchen.test/veranstaltungen/heute'
const pages = {
  [HUB]: `Veranstaltungen\n* [Programm für heute](${LIST})`,
  [LIST]: `Termine\n* [Konzert](${LIST}/k) — heute 20:00 — Gasteig`,
  [LIST + '?seite=2']: `Termine\n* [Lesung](${LIST}/l) — heute 21:00 — Literaturhaus`,
}
let fetched = []
const pageApi = fakeApi({
  answer: (p) => {
    const url = (p.match(/--- page text of (\S+) ---/) || [])[1]
    if (url === HUB) return JSON.stringify({ tz: 'UTC', events: [], listing_urls: [LIST] })
    if (url === LIST) return JSON.stringify({ tz: 'UTC', events: [ev('Konzert')], next_url: LIST + '?seite=2' })
    if (url) return JSON.stringify({ tz: 'UTC', events: [ev('Lesung', 1)] })
    return harvest([])   // the open-web pass
  },
})
run = await runScout({}, {
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1,
  sources: [{ url: HUB, name: 'Stadtportal', kind: 'city' }],
  api: pageApi,
  fetchPage: async (u) => { fetched.push(u); if (!pages[u]) throw new PageUnavailable(u, '404'); return pages[u] },
})
assert.deepEqual(fetched, [HUB, LIST, LIST + '?seite=2'], 'the hub is followed to the listing and then paginated')
assert.deepEqual(run.candidates.map(c => c.title), ['Konzert', 'Lesung'])
assert.ok(pageApi.opts.slice(0, 3).every(o => o.search === false),
  'extraction from a page we fetched costs no search fee')
assert.equal(pageApi.opts[3].search, true, 'the open-web pass is still a search')
assert.deepEqual(run.productive.map(s => s.url), [LIST, LIST + '?seite=2'],
  'the pages that held events go to the registry - the hub that held none does not')

// A city-wide film programme is one page with every cinema on it -
// in-muenchen.de/kino/alle-kinos.html is 191k characters, 41 cinemas, 661
// showings. One extraction call sees 60k of that, so reading the page once is
// reading the cinemas up to the letter C. It is read slice by slice instead,
// and fetched only once: re-fetching costs a rate limit and risks the page
// changing under us mid-run.
{
  const PROG = 'https://kino.test/alle-kinos'
  const filler = (n) => Array.from({ length: n }, (_, i) => `Kino ${i} - Film ${i} - 20:00`).join('\n')
  // Three slices' worth, with events on every one of them.
  const whole = ['A' + filler(800), 'B' + filler(800), 'C' + filler(800)]
    .map(part => part.padEnd(SLICE_CHARS, ' ')).join('')
  const seen = []
  let fetches = 0
  const sliceRun = await runScout({}, {
    city: 'Testheim', from: FROM, to: TO, budgetUsd: 1,
    sources: [{ url: PROG, name: 'Kinoprogramm', kind: 'cinema' }],
    api: fakeApi({
      answer: (p) => {
        const body = (p.match(/--- page text of \S+ ---\n([\s\S]*)\n--- end of page ---/) || [])[1]
        if (body === undefined) return harvest([])          // the open-web pass
        seen.push(body[0])
        return JSON.stringify({ tz: 'UTC', events: [ev('Film ' + body[0])] })
      },
    }),
    fetchPage: async () => { fetches++; return whole },
  })
  assert.deepEqual(seen, ['A', 'B', 'C'], 'every slice of the programme is read, not just the first')
  assert.equal(fetches, 1, 'a long page is fetched once and sliced, not re-fetched per slice')
  assert.deepEqual(sliceRun.candidates.map(c => c.title).sort(), ['Film A', 'Film B', 'Film C'])
  assert.deepEqual(sliceRun.productive.map(s => s.url), [PROG],
    'the programme goes to the registry once, not once per slice')
  assert.equal(sliceRun.productive[0].covers, '3 events in one listing',
    'what it covers is every slice together')
}

// A first slice that is all navigation still earns a second look; a second one
// that yields nothing ends the page.
{
  const NAV = 'https://nav.test/events'
  const whole = 'menu '.repeat(SLICE_CHARS / 5) + 'Konzert 20:00' 
  let calls = 0
  const navRun = await runScout({}, {
    city: 'Testheim', from: FROM, to: TO, budgetUsd: 1,
    sources: [{ url: NAV, name: 'Nav', kind: 'city' }],
    api: fakeApi({
      answer: (p) => {
        if (!/--- page text of/.test(p)) return harvest([])
        calls++
        return calls === 1 ? harvest([]) : JSON.stringify({ tz: 'UTC', events: [ev('Konzert')] })
      },
    }),
    fetchPage: async () => whole,
  })
  assert.equal(calls, 2, 'an empty first slice is followed by the second, where the events are')
  assert.deepEqual(navRun.candidates.map(c => c.title), ['Konzert'])
  assert.deepEqual(navRun.productive.map(s => s.url), [NAV],
    'a page whose first slice was empty is still a catalogue if a later slice paid off')
  assert.deepEqual(navRun.barren, [], 'and it is not filed as barren')
}

// A page that will not load is not a dead end: the run asks the model instead,
// which is all it could ever do before.
run = await runScout({}, {
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1,
  sources: [{ url: 'https://blocked.test/events', name: 'Blocked' }],
  api: fakeApi({ answer: () => harvest([ev('Found Anyway')]) }),
  fetchPage: async (u) => { throw new PageUnavailable(u, 'cors') },
})
assert.deepEqual(run.candidates.map(c => c.title), ['Found Anyway'])

assert.equal(shortUrl('https://www.muenchen.de/veranstaltungen/event/heute'), 'muenchen.de/veranstaltungen/event/heu…')
assert.equal(shortUrl('https://one.test/events'), 'one.test/events')

// ---------- the reader ----------

assert.equal(htmlToText('<div>Konzert<script>junk()</script><br>20:00 &amp; sold out</div>'), 'Konzert \n20:00 & sold out')

// Direct first, because a catalogue that allows it costs nothing extra; the
// reader second, because almost none of them do.
let calls = []
const fakeFetch = (behaviour) => async (url) => {
  calls.push(url)
  const r = behaviour(url)
  if (r instanceof Error) throw r
  return { ok: r !== null, status: r === null ? 451 : 200, text: async () => r }
}
const long = 'Termine 20:00\n'.repeat(200).trim()
assert.equal(await readPage('https://ok.test/x', { fetchImpl: fakeFetch(() => long) }), long)
assert.deepEqual(calls, ['https://ok.test/x'], 'a CORS-friendly catalogue is never sent through the reader')

calls = []
const viaReader = await readPage('https://cors.test/x', {
  fetchImpl: fakeFetch((u) => u.startsWith('https://r.jina.ai/') ? long : new TypeError('CORS')),
})
assert.equal(viaReader, long)
assert.deepEqual(calls, ['https://cors.test/x', 'https://r.jina.ai/https://cors.test/x'])

await assert.rejects(
  readPage('https://dead.test/x', { fetchImpl: fakeFetch(() => new TypeError('nope')) }),
  (err) => err instanceof PageUnavailable && /could not read https:\/\/dead\.test\/x/.test(err.message))

// A listing is cut at the end, never in the middle: the tail is pagination
// furniture, the head is the events.
const clipped = await readPage('https://ok.test/x', { fetchImpl: fakeFetch(() => long), maxChars: 100 })
assert.ok(clipped.startsWith(long.slice(0, 100)) && clipped.endsWith('[page truncated]'))


// Catalogues do not depend on each other, so they are read at the same time -
// the visitor waits for the slowest, not for the sum. The budget is reserved
// when a job starts, not when its call goes out, or three workers would each
// decide they fit while the other two were still fetching.
let live = 0, peak = 0
const slow = async (fn) => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 30)); live--; return fn() }
run = await runScout({}, {
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 1,
  sources: [1, 2, 3, 4, 5].map(n => ({ url: `https://cat${n}.test/events` })),
  fetchPage: (u) => slow(() => `Termine\n* ${u}`),
  api: fakeApi({ answer: (p) => {
    const n = (p.match(/cat(\d)/) || [])[1]
    return JSON.stringify({ tz: 'UTC', events: n ? [ev('Show ' + n)] : [] })
  } }),
})
assert.equal(run.candidates.length, 5, 'all five catalogues were read')
assert.ok(peak > 1, 'catalogues are fetched concurrently, peak was ' + peak)
assert.ok(peak <= 3, 'and no wider than the pool, peak was ' + peak)

// A budget that only fits two calls still only buys two, however many workers
// are racing for it.
run = await runScout({}, {
  city: 'Testheim', from: FROM, to: TO, budgetUsd: 0.05,
  sources: [1, 2, 3, 4, 5].map(n => ({ url: `https://cat${n}.test/events` })),
  fetchPage: (u) => slow(() => `Termine\n* ${u}`),
  api: fakeApi({ answer: () => JSON.stringify({ tz: 'UTC', events: [] }) }),
})
assert.equal(run.calls.length, 2, 'concurrency does not loosen the budget: ' + run.calls.length + ' calls')
assert.ok(run.costUsd <= 0.05)

// ---------- geocoding budget ----------

let lookups = 0
const geocode = makeGeocoder({ limit: 2, lookup: async () => { lookups++; return { lat: 1, lon: 2 } } })
await geocode('Gasteig', 'München')
await geocode('Gasteig', 'München')
await geocode('Volkstheater', 'München')
await geocode('Blitz', 'München')
assert.equal(lookups, 2, 'venues are memoised and the total is capped')
assert.equal(await makeGeocoder({ enabled: false })('Gasteig', 'München'), null)

// Pasting an existing credit id mints a capped sub-key, and PPQ rejects a key
// name over 25 characters with a 400 - which "tonight-events-page-" plus a
// random suffix was, so adoption failed for everyone who tried it.
for (const r of [Math.random(), 0.1, 0.999999]) {
  assert.ok(keyName(r).length <= KEY_NAME_MAX, `key name fits: ${keyName(r)}`)
  assert.ok(keyName(r).length > 8, 'and still has a unique suffix, or a second adoption is a 409')
}
assert.notEqual(keyName(0.1), keyName(0.2))

console.log('scout tests ok')


// The credit balance is not the ceiling a run actually hits. The page mints a
// capped sub-key, and that cap is lower: a $1 key on a $2 credit refuses every
// call once it has spent its dollar, while /credits/balance still cheerfully
// reports $2. The run then sees money it cannot spend, keeps starting calls
// that come back 402, and finishes claiming "budget spent" when the truth is
// that the key is used up. So a balance is the smaller of the two.
{
  const realFetch = globalThis.fetch
  const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
  globalThis.fetch = async (url) => url.endsWith('/credits/balance')
    ? json({ balance: 2 })
    : json({ status: 'success', data: [
        { name: 'tonight-other', usage_limit_usd: 5, current_period_usage_usd: 0 },
        { name: 'tonight-abc123', usage_limit_usd: 1, current_period_usage_usd: 0.87 },
      ] })
  try {
    assert.equal(
      await getBalance({ apiKey: 'sk-x', creditId: 'cid', keyName: 'tonight-abc123' }),
      +(1 - 0.87).toFixed(10),
      'the sub-key cap, not the credit, is what the run has left')
    assert.equal(
      await getBalance({ apiKey: 'sk-x', creditId: 'cid', keyName: 'tonight-gone' }),
      2, 'a key we cannot find leaves the credit balance standing')
    assert.equal(
      await getBalance({ apiKey: 'sk-x' }), 2,
      'a pasted api key with no credit id has no cap we can read')
  } finally { globalThis.fetch = realFetch }
}

console.log('balance ceiling tests ok')

// A page that was a fine catalogue for one evening and a dead link every
// evening after does not belong in a registry that outlives the run.
for (const u of [
  'https://www.kino-zeit.de/kinoprogramm/ort/M%C3%BCnchen/tag/17-09-2026',
  'https://x.de/events/2026-09-17', 'https://x.de/e/17.09.2026', 'https://x.de/p/20260917',
]) assert.ok(isDatedUrl(u), `day-specific: ${u}`)
for (const u of [
  'https://allekinos.de/programm?stadt=M%C3%BCnchen',
  'https://www.muenchen.de/veranstaltungen/event/heute',
  'https://www.in-muenchen.de/kino/alle-kinos.html',
  'https://www.cinema.de/index.php/kino/kinoprogramm/muenchen',
]) assert.ok(!isDatedUrl(u), `stays true tomorrow: ${u}`)

console.log('dated url tests ok')
