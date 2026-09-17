// Screenshot the deployed nsite against the real public relays.
import { chromium } from 'playwright-core'
const URL_ = process.argv[2] || 'https://npub1cq62z4lcy0zlmct7rzmlwg0dxakxes9ce72zkd6q3mm53nvscpqqlndync.nsite.lol/'
const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, locale: 'de-DE', timezoneId: 'Europe/Berlin' })
page.on('pageerror', e => console.log('page exception:', e.message))
await page.goto(URL_ + '?city=munchen&when=week', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(12000)
const cards = await page.$$eval('.card h3', ns => ns.map(n => n.textContent))
console.log('cards on the live site:', cards.length, cards.slice(0, 8))
console.log('status:', (await page.textContent('#status')) || '(none)')
console.log('runinfo:', await page.textContent('#runinfo'))
await page.screenshot({ path: '.scratch/shots/10-live-munich.png', fullPage: true })
await browser.close()
