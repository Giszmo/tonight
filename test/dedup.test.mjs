import assert from 'node:assert/strict'
import { dedupId, groupCopies, groupHasTag, groupTags, sameEvent, normalizeTitle } from '../src/events.js'

const mk = (o) => ({ id: o.id || Math.random().toString(36).slice(2), d: o.d || '', address: o.address || '',
  title: o.title, venue: o.venue || '', start: o.start, coords: o.coords || null, refs: o.refs || [],
  image: '', summary: o.summary || '', end: null, createdAt: o.createdAt || 1, hashtags: [] })

// same concert, two publishers, different wording and a 6-minute clock skew
const a = mk({ title: 'Die Ärzte live in München', venue: 'Olympiahalle München', start: 1789200000, refs: ['https://venue.example/x'] })
const b = mk({ title: 'DIE AERZTE - Live!', venue: 'Olympiahalle', start: 1789200360 })
assert.equal(sameEvent(a, b), true, 'umlaut/venue variants must collapse')

// deterministic d tag agrees for the normalised form
assert.equal(await dedupId({ title: 'Die Aerzte', venue: 'Olympiahalle', start: 1789200000 }),
             await dedupId({ title: 'die ärzte', venue: 'Olympiahalle!', start: 1789200400 }),
             'd tag must be stable across umlauts, punctuation and sub-quarter-hour skew')

// different band, same hall, same night must not collapse
const c = mk({ title: 'Rammstein', venue: 'Olympiahalle', start: 1789200000 })
assert.equal(sameEvent(a, c), false, 'different events in one venue must stay apart')

// same title, different venue across town must not collapse
const d1 = mk({ title: 'Tatort Lesung', venue: 'Volkstheater', start: 1789200000 })
const d2 = mk({ title: 'Tatort Lesung', venue: 'Muffatwerk', start: 1789200000 })
assert.equal(sameEvent(d1, d2), false, 'same title in two venues must stay apart')

// grouping picks the richer copy as canonical
const g = groupCopies([b, a, c])
assert.equal(g.length, 2)
const concert = g.find(x => x.copies.length === 2)
assert.equal(concert.canonical.id, a.id, 'copy with a source URL wins')

// venue unknown on both sides: only a near-identical title collapses
const e1 = mk({ title: 'Jazz Jam Session', start: 1789200000 })
const e2 = mk({ title: 'Jazz Jam Session', start: 1789200000 })
const e3 = mk({ title: 'Jazz Night Quartett', start: 1789200000 })
assert.equal(sameEvent(e1, e2), true)
assert.equal(sameEvent(e1, e3), false)

console.log('dedup tests ok')

// the shape that actually occurs: magazine wording vs ticket-shop wording
const f1 = mk({ title: 'Münchner Kammerorchester: Schubert', venue: 'Prinzregententheater', start: 1789200000 })
const f2 = mk({ title: 'Kammerorchester München - Schubert (Prinzregententheater)', venue: 'Prinzregententheater München', start: 1789200300 })
assert.equal(sameEvent(f1, f2), true, 'same concert, two publishers, different wording')

// same venue and hour but a genuinely different show must not be swallowed
const f3 = mk({ title: 'Sonntagsmatinee: Mozart Klavierkonzerte', venue: 'Prinzregententheater', start: 1789200000 })
assert.equal(sameEvent(f1, f3), false, 'different programme in the same hall stays separate')
console.log('dedup tests ok (extended)')

// tag filter: a group answers for the tags of every copy, folded to slugs
const t1 = mk({ title: 'Kammerorchester Schubert', venue: 'Prinzregententheater', start: 1789200000 })
t1.hashtags = ['Konzert', 'München']
const t2 = mk({ title: 'Kammerorchester - Schubert', venue: 'Prinzregententheater München', start: 1789200300 })
t2.hashtags = ['concert', 'klassik']
const t3 = mk({ title: 'Open-Air-Kino', venue: 'Westpark', start: 1789200000 })
t3.hashtags = ['cinema']
const tg = groupCopies([t1, t2, t3])
const concertGroup = tg.find(g => g.copies.length === 2)
assert.deepEqual([...groupTags(concertGroup)].sort(), ['concert', 'klassik', 'konzert', 'munchen'])
assert.equal(groupHasTag(concertGroup, 'concert'), true, 'the copy tag filters the whole group')
assert.equal(groupHasTag(concertGroup, 'Konzert'), true, 'filtering folds case and umlauts')
assert.equal(groupHasTag(concertGroup, 'cinema'), false)
assert.equal(groupHasTag(concertGroup, null), true, 'no filter keeps everything')
assert.equal(tg.filter(g => groupHasTag(g, 'concert')).length, 1, 'filtering a list keeps one card')
console.log('tag filter tests ok')
