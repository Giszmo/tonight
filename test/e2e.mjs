// Drives the real page in a real browser against a throwaway relay.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { startRelay } from './relay.mjs'
import { serveSite } from './serve.mjs'
import { munichFixtures } from './fixtures.mjs'

const CHROME = process.env.CHROME_PATH || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'
const SHOTS = '.scratch/shots'
mkdirSync(SHOTS, { recursive: true })

const relay = await startRelay()
const site = await serveSite('site')
const { events } = await munichFixtures()
for (const ev of events) relay.add(ev)
console.log(`relay ${relay.url} seeded with ${events.length} events; site ${site.url}`)

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2, locale: 'de-DE', timezoneId: 'Europe/Berlin' })
page.on('console', m => { if (m.type() === 'error') console.log('  page error:', m.text()) })
page.on('pageerror', e => console.log('  page exception:', e.message))

await page.addInitScript(([relayUrl]) => {
  localStorage.setItem('tonight.relays', JSON.stringify([relayUrl]))
}, [relay.url])

await page.goto(site.url + '/?city=munchen&when=week', { waitUntil: 'networkidle' })
await page.waitForSelector('.card', { timeout: 15000 })
await page.waitForTimeout(1500)

const cards = await page.$$('.card')
const titles = await page.$$eval('.card h3', ns => ns.map(n => n.textContent))
console.log('cards rendered:', cards.length)
console.log(titles.map(t => '  - ' + t).join('\n'))
assert.ok(cards.length >= 4, 'expected the fixture events to render')
assert.ok(!titles.some(t => t.includes('muenchenticket')), 'no raw duplicate title')
const dupCollapsed = titles.filter(t => t.toLowerCase().includes('schubert')).length
assert.equal(dupCollapsed, 1, 'the concert published twice must render once')

const sources = await page.$$eval('.card .src', ns => ns.map(n => n.textContent))
assert.ok(sources.some(s => s.includes('m-k-o.eu')), 'canonical copy keeps its source link')
const counts = await page.$$eval('.counts', ns => ns.map(n => n.textContent))
assert.ok(counts.some(c => /3 going/.test(c)), 'RSVPs are counted: ' + JSON.stringify(counts))
const runinfo = await page.textContent('#runinfo')
console.log('runinfo:', runinfo)
assert.match(runinfo, /Last scouted 2 days ago/)
assert.match(runinfo, /\$0\.02[0-9]/, 'cost estimate is the median of past runs')

await page.screenshot({ path: SHOTS + '/01-list.png', fullPage: true })

// endorse the first event and check the relay really got a signed RSVP
const before = relay.events.length
await page.click('.card .going')
await page.waitForTimeout(1200)
const published = relay.events.slice(before)
console.log('published by the going button:', published.map(e => e.kind))
assert.ok(published.some(e => e.kind === 31925), 'RSVP published')
assert.ok(published.some(e => e.kind === 7), 'reaction published')
assert.equal(await page.textContent('.card .going'), 'going ✓')

// clicking a tag filters the list, and the filter is in the URL so it can be shared
const allCards = (await page.$$('.card')).length
await page.click('.card .tag:has-text("#concert")')
await page.waitForTimeout(400)
const concertTitles = await page.$$eval('.card h3', ns => ns.map(n => n.textContent))
console.log('after #concert:', concertTitles)
assert.equal(concertTitles.length, 1, 'only the concert survives the filter')
assert.match(concertTitles[0], /Schubert/)
assert.match(await page.textContent('#filter'), /#concert/)
assert.ok(page.url().includes('tag=concert'), 'the filter is shareable: ' + page.url())
await page.screenshot({ path: SHOTS + '/04-tagfilter.png', fullPage: true })

// a filter with no hits explains itself instead of showing the never-scouted text
await page.click('#filter .chip')
await page.waitForTimeout(300)
assert.equal((await page.$$('.card')).length, allCards, 'clearing the filter restores every card')
assert.ok(!page.url().includes('tag='), 'the cleared filter leaves the URL')

// the same filter straight from the URL, on a tag only the second copy carries
await page.goto(site.url + '/?city=munchen&when=week&tag=cinema', { waitUntil: 'networkidle' })
await page.waitForSelector('.card', { timeout: 15000 })
await page.waitForTimeout(800)
const fromUrl = await page.$$eval('.card h3', ns => ns.map(n => n.textContent))
assert.equal(fromUrl.length, 1, '?tag=cinema filters on load: ' + JSON.stringify(fromUrl))
assert.match(fromUrl[0], /Kino/)
await page.click('#filter .chip')
await page.waitForTimeout(300)

// the scout flow without money: PPQ must be asked, and the empty balance has to
// surface as a top-up sheet rather than an error
await page.click('#scout')
await page.waitForSelector('dialog[open]', { timeout: 30000 })
await page.waitForTimeout(800)
const sheet = await page.textContent('#sheet-body')
console.log('sheet:', sheet.slice(0, 160).replace(/\s+/g, ' '))
assert.match(sheet, /Top up to scout/)
await page.screenshot({ path: SHOTS + '/02-topup.png' })
await page.click('.ghost:has-text("$0.100")').catch(() => page.click('#sheet-body .ghost'))
await page.waitForTimeout(4000)
const invoiceText = await page.textContent('#sheet-body')
console.log('invoice sheet:', invoiceText.replace(/\s+/g, ' ').slice(0, 220))
assert.match(invoiceText, /lnbc|sat/i, 'a real Lightning invoice came back from PPQ')
await page.screenshot({ path: SHOTS + '/03-invoice.png' })

// ---- the whole paid path, on fake money (?mock=1, src/mockppq.js) ----
// Budget, catalogue discovery, a multi-call harvest, dedup against what the
// city already has, publishing, and the registry the next visitor reads.
const m = await browser.newPage({ viewport: { width: 430, height: 940 }, deviceScaleFactor: 2, locale: 'de-DE', timezoneId: 'Europe/Berlin' })
m.on('pageerror', e => console.log('  mock page exception:', e.message))
m.on('console', e => { if (e.type() === 'error') console.log('  mock page error:', e.text()) })
await m.addInitScript(([relayUrl]) => localStorage.setItem('tonight.relays', JSON.stringify([relayUrl])), [relay.url])
await m.goto(site.url + '/?city=munchen&when=week&mock=1', { waitUntil: 'networkidle' })
await m.waitForSelector('.card')
const listedBefore = (await m.$$('.card')).length

// empty balance -> top up -> the paid state, which is a state and not a sentence
await m.click('#scout')
await m.waitForSelector('#sheet-body')
await m.click('#sheet-body .ghost:has-text("$1.00")')
await m.waitForSelector('#payst')
await m.waitForSelector('.paid', { timeout: 30000 })
const paidText = (await m.textContent('#sheet-body')).replace(/\s+/g, ' ')
console.log('paid sheet:', paidText.slice(0, 160))
assert.match(paidText, /Paid/)
assert.match(paidText, /\$1\.05/, 'the new balance is shown, including the 5% Lightning bonus')
assert.ok((await m.$$('.confetti i')).length > 20, 'the payment is celebrated, not announced in small print')
await m.screenshot({ path: SHOTS + '/05-paid.png' })

// the budget is the visitor's decision, and the sheet says what it buys
await m.click('#sheet-body .primary')
await m.waitForSelector('.budgets')
const scoutSheet = (await m.textContent('#sheet-body')).replace(/\s+/g, ' ')
console.log('scout sheet:', scoutSheet.slice(0, 200))
assert.match(scoutSheet, /Spend at most/)
assert.match(scoutSheet, /events are already listed here/, 'known events are declared as part of the deal')
await m.screenshot({ path: SHOTS + '/06-budget.png' })
await m.click('#sheet-body .primary:has-text("Start the run")')

// the run is visible while it happens
await m.waitForSelector('.runlog li')
await m.waitForTimeout(1500)
console.log('run log:', (await m.$$eval('.runlog li', ns => ns.map(n => n.textContent))).join(' | '))
await m.screenshot({ path: SHOTS + '/07-running.png' })

await m.waitForSelector('.candidates', { timeout: 120000 })
const candSummary = (await m.textContent('#sheet-body')).replace(/\s+/g, ' ')
console.log('candidates:', candSummary.slice(0, 220))
const cands = await m.$$('.cand')
console.log(`  ${cands.length} candidates`)
assert.ok(cands.length >= 30, 'a run walks catalogues instead of returning a handful: ' + cands.length)
assert.match(candSummary, /calls over \d+ catalogues/)
// The ticket shop in the mock re-lists an event the city already has, under its
// own wording. It must be found and then dropped, not offered for publishing.
const ticketRun = /muenchenticket\.de\S* (\d+)\/(\d+)/.exec(candSummary)
assert.ok(ticketRun && Number(ticketRun[1]) < Number(ticketRun[2]),
  'the re-listed event is found and then dropped: ' + (ticketRun ? ticketRun[0] : 'no ticket-shop line'))
assert.equal((await m.$$('.cand.dup')).length, 0, 'nothing already published survives into the review list')
await m.screenshot({ path: SHOTS + '/08-candidates.png' })

const beforePublish = relay.events.length
await m.click('#sheet-body .primary:has-text("publish")')
await m.waitForFunction(() => !document.getElementById('sheet').open, null, { timeout: 180000 })
await m.waitForTimeout(2500)
const publishedByRun = relay.events.slice(beforePublish)
const kinds = publishedByRun.reduce((a, e) => (a[e.kind] = (a[e.kind] || 0) + 1, a), {})
console.log('published by the run:', JSON.stringify(kinds))
assert.ok((kinds[31923] || 0) >= 30, 'the whole harvest is published, not a sample')
assert.equal(kinds[2121], 1, 'one scout-run record')
assert.ok((kinds[31121] || 0) >= 3, 'the catalogues are published so the next visitor does not pay to find them')
const anEvent = publishedByRun.find(e => e.kind === 31923)
assert.equal(anEvent.tags.find(t => t[0] === 'start_tzid')[1], 'Europe/Berlin', 'events carry the city zone')
assert.ok(anEvent.tags.some(t => t[0] === 'r' && /^https:/.test(t[1])), 'every published event keeps its source URL')

await m.waitForSelector('.card')
await m.waitForTimeout(1500)
const listedAfter = (await m.$$('.card')).length
console.log(`cards before the run: ${listedBefore}, after: ${listedAfter}`)
assert.ok(listedAfter > listedBefore + 20, 'the city listing actually filled up')
await m.screenshot({ path: SHOTS + '/09-filled.png', fullPage: true })

// second visitor: the catalogues now come off the relay instead of a paid search
await m.goto(site.url + '/?city=munchen&when=week&mock=1', { waitUntil: 'networkidle' })
await m.waitForSelector('.card')
await m.click('#scout')
await m.waitForSelector('.budgets', { timeout: 60000 })
const secondRun = (await m.textContent('#sheet-body')).replace(/\s+/g, ' ')
console.log('second run sheet:', secondRun.slice(0, 200))
assert.match(secondRun, /catalogues for München are already on the relays/, 'the registry is read back')
await m.screenshot({ path: SHOTS + '/10-registry.png' })
await m.keyboard.press('Escape')

// desktop shot for the record
const wide = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, locale: 'de-DE', timezoneId: 'Europe/Berlin' })
await wide.addInitScript(([relayUrl]) => localStorage.setItem('tonight.relays', JSON.stringify([relayUrl])), [relay.url])
await wide.goto(site.url + '/?city=munchen&when=week', { waitUntil: 'networkidle' })
await wide.waitForSelector('.card')
await wide.waitForTimeout(1500)
await wide.screenshot({ path: SHOTS + '/04-desktop.png', fullPage: true })

await browser.close()
site.close()
relay.close()
console.log('e2e ok')
process.exit(0)
