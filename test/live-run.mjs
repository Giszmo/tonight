// A real scouting run against the real PPQ API and the real web.
// Costs money. Usage: PPQ_KEY=sk-… node test/live-run.mjs "München" DE [budget] [hours]
import { runScout } from '../src/scout.js'
import * as ppq from '../src/ppq.js'

const key = process.env.PPQ_KEY
if (!key) throw new Error('PPQ_KEY required')
const acc = { creditId: process.env.PPQ_CREDIT || '', apiKey: key }

const city = process.argv[2] || 'München'
const country = process.argv[3] || 'Germany'
const budgetUsd = Number(process.argv[4] || 0.25)
const hours = Number(process.argv[5] || 0)   // 0 = until end of today, city time
const tz = process.env.TZ_CITY || 'Europe/Berlin'
const lat = Number(process.env.LAT || 48.137), lon = Number(process.env.LON || 11.575)

const now = Math.floor(Date.now() / 1000)
let to
if (hours) to = now + hours * 3600
else {
  const local = new Date().toLocaleString('sv-SE', { timeZone: tz })       // "YYYY-MM-DD HH:MM:SS"
  const endLocal = local.slice(0, 10) + 'T23:59'
  const { zonedToSeconds } = await import('../src/scout.js')
  to = zonedToSeconds(endLocal, tz)
}
console.log(`${city}: window ${new Date(now * 1000).toISOString()} .. ${new Date(to * 1000).toISOString()}, budget $${budgetUsd}`)

const t0 = Date.now()
const run = await runScout(acc, {
  city, country, lat, lon, from: now, to,
  known: [], budgetUsd,
  api: { getBalance: (a) => ppq.getBalance(a), chat: (a, o) => ppq.chat(a, o) },
  onProgress: (p) => { if (p.label) console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s $${p.spent?.toFixed?.(4) ?? '?'}] ${p.label}`) },
})

console.log('\n=== run ===')
console.log('stopped because:', run.stoppedBecause, '| cost $' + run.costUsd, '| calls', run.calls.length, '| tz', run.tz)
console.log('catalogues:', run.sources.map(s => s.url).join('\n            '))
console.log('productive pages:', run.productive.map(p => p.url).join('\n                  '))
console.log('\ncalls:')
for (const c of run.calls) console.log(`  ${c.failed ? 'FAIL ' : ''}${c.label} -> found ${c.found ?? '-'} new ${c.added ?? '-'} $${c.costUsd}`)
console.log(`\n=== ${run.candidates.length} events ===`)
const fmt = (s) => new Date(s * 1000).toLocaleString('sv-SE', { timeZone: tz }).slice(0, 16)
const byCat = {}
for (const c of run.candidates) {
  byCat[c.category] = (byCat[c.category] || 0) + 1
  console.log(`  ${fmt(c.start)}  ${c.category.padEnd(10)} ${c.title.slice(0, 70)} @ ${c.venue} [${c.source}]`)
}
console.log('\nby category:', JSON.stringify(byCat))
const { writeFileSync } = await import('node:fs')
writeFileSync(process.env.OUT || '/root/carol-agent/.scratch/live-run.json', JSON.stringify(run, null, 2))
