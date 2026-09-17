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
