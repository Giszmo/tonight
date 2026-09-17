// Fixture events: a realistic Munich evening, including one concert published
// twice by two different scouts so the dedup path is exercised in the UI.
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { buildEventTags, dedupId, KIND_TIME_EVENT, KIND_RSVP, KIND_REACTION, KIND_SCOUT_RUN } from '../src/events.js'

const MUC = { lat: 48.1374, lon: 11.5755 }

export async function munichFixtures(now = Math.floor(Date.now() / 1000)) {
  const scoutA = generateSecretKey(), scoutB = generateSecretKey(), human = generateSecretKey()
  const tonightAt = (h, m = 0) => {
    const d = new Date(now * 1000)
    d.setHours(h, m, 0, 0)
    if (d.getTime() / 1000 < now) d.setDate(d.getDate() + 1)
    return Math.floor(d.getTime() / 1000)
  }

  const defs = [
    { sk: scoutA, title: 'Münchner Kammerorchester: Schubert', venue: 'Prinzregententheater', start: tonightAt(20), cat: 'concert', lat: 48.1424, lon: 11.5968, url: 'https://www.m-k-o.eu/konzerte/schubert', summary: 'Streicher und ein spätes Quartett, 19:30 Einlass.' },
    { sk: scoutA, title: 'Tatort-Lesung mit Live-Musik', venue: 'Volkstheater', start: tonightAt(19, 30), cat: 'theatre', lat: 48.1321, lon: 11.5514, url: 'https://www.muenchner-volkstheater.de/tatort', summary: 'Krimi-Lesung mit Bühnenband.' },
    { sk: scoutB, title: 'Techno: Nachtdigital Label Night', venue: 'Blitz Club', start: tonightAt(23), cat: 'club', lat: 48.1311, lon: 11.5861, url: 'https://blitz.club/events/nachtdigital', summary: 'Funktion-One, bis in den Morgen.' },
    { sk: scoutB, title: 'Open-Air-Kino: Perfect Days', venue: 'Kino, Mond & Sterne', start: tonightAt(21), cat: 'cinema', lat: 48.1256, lon: 11.5490, url: 'https://kinomondsterne.de/programm', summary: 'Wim Wenders, OmU.' },
    { sk: scoutA, title: 'Flohmarkt auf der Theresienwiese', venue: 'Theresienwiese', start: tonightAt(8), cat: 'market', lat: 48.1316, lon: 11.5497, url: 'https://www.muenchen.de/flohmarkt', summary: 'Riesenflohmarkt, Aufbau ab 6 Uhr.' },
  ]

  const out = []
  for (const def of defs) {
    out.push(await mk(def))
  }
  // the same concert, found by the other scout on the ticket site
  out.push(await mk({
    sk: scoutB,
    title: 'Kammerorchester München - Schubert (Prinzregententheater)',
    venue: 'Prinzregententheater München',
    start: defs[0].start + 300,
    cat: 'concert', lat: 48.1424, lon: 11.5968,
    url: 'https://www.muenchenticket.de/x/schubert',
  }))

  const concert = out[0]
  const address = `${concert.kind}:${concert.pubkey}:${concert.tags.find(t => t[0] === 'd')[1]}`
  for (const sk of [human, scoutB, generateSecretKey()]) {
    out.push(finalizeEvent({
      kind: KIND_RSVP, created_at: now - 3600, content: '',
      tags: [['d', Math.random().toString(36).slice(2)], ['a', address], ['e', concert.id], ['p', concert.pubkey], ['status', 'accepted']],
    }, sk))
  }
  out.push(finalizeEvent({
    kind: KIND_REACTION, created_at: now - 1800, content: '+',
    tags: [['a', address], ['e', concert.id], ['p', concert.pubkey]],
  }, human))

  out.push(finalizeEvent({
    kind: KIND_SCOUT_RUN, created_at: now - 2 * 86400, content: 'Scouted München: 9 candidates, 6 published, $0.024 of inference.',
    tags: [['t', 'munchen'], ['found', '9'], ['published', '6'], ['cost_usd', '0.0240'], ['model', 'gemini-3.7-flash:online'], ['g', 'u281'], ['alt', 'scout run for München']],
  }, scoutA))
  out.push(finalizeEvent({
    kind: KIND_SCOUT_RUN, created_at: now - 5 * 86400, content: 'Scouted München: 7 candidates, 5 published, $0.031 of inference.',
    tags: [['t', 'munchen'], ['found', '7'], ['published', '5'], ['cost_usd', '0.0310'], ['model', 'gemini-3.7-flash:online'], ['g', 'u281']],
  }, scoutB))

  return { events: out, pubkeys: { scoutA: getPublicKey(scoutA), scoutB: getPublicKey(scoutB), human: getPublicKey(human) } }

  async function mk({ sk, title, venue, start, cat, lat, lon, url, summary }) {
    const d = await dedupId({ title, venue, start })
    return finalizeEvent({
      kind: KIND_TIME_EVENT,
      created_at: now - 7200,
      content: summary || '',
      tags: buildEventTags({
        d, title, summary, start, end: start + 3 * 3600, venue, lat, lon,
        city: 'München', category: cat, url,
      }),
    }, sk)
  }
}

export { MUC }
