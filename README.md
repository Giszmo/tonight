# Tonight

A single static page that answers "what is on near me?" from public nostr relays,
and lets whoever wants fresher data pay for one scouting run in their own browser.

- **Reading is free.** Anything a previous visitor scouted is on the relays as
  [NIP-52](https://github.com/nostr-protocol/nips/blob/master/52.md) events.
- **Scouting is on demand and visitor-paid.** No cron, no scraper, no server of
  ours. A run walks the city's event catalogues — the what-is-on magazine, the
  municipal calendar, the ticket platform, the big venues — with
  [PPQ.ai](https://ppq.ai) calls that have web search, paid from an anonymous
  credit the page creates on first use and tops up over Lightning. The visitor
  sets the ceiling ("spend at most $0.25") and the run stops there.
- **The catalogues themselves live on nostr** (kind 31121), so finding them is
  paid for once per city rather than once per visitor.
- **Nothing is collected twice.** Everything the city already has is fed into
  the search and filtered out of the results again, so a second run buys what is
  missing.
- **What one visitor pays for, everyone else reads for free.** Candidates are
  reviewed by the person who triggered the run and published under their key.
- **Endorsements are nostr-native.** One "going" button emits a NIP-52 RSVP
  (kind 31925) and a reaction (kind 7) on the event's address.

Everything runs in the browser: relays over WebSocket, PPQ over CORS, geocoding
via [Photon](https://photon.komoot.io). The deploy target is an
[nsite](https://github.com/nostr-protocol/nips/pull/2020) — the site itself
lives on nostr and Blossom.

## Run it

```sh
npm install
npm run build        # bundles src/ + style.css into site/index.html
npm test             # dedup, prompt, run-loop and zone unit tests
npm run e2e          # drives site/ in headless Chromium against a throwaway relay
npx serve site       # or any static server
```

`npm run e2e` starts an in-memory relay, seeds a Munich evening (including one
concert published twice by two scouts), and checks that the page renders it,
collapses the duplicate, counts RSVPs, publishes a signed RSVP when you click
"going", and opens a real PPQ Lightning invoice when the balance is empty.

It then re-runs the whole paid path on fake money (`?mock=1`): top-up →
confetti → budget → catalogue discovery → a multi-call harvest → candidate
review → publishing ~75 events, the scout-run record and the catalogue registry
to the relay, and a second visit that reads the catalogues back instead of
paying to find them. Screenshots land in `.scratch/shots/`.

Open `?mock=1` in a browser to click through the paid flow yourself without
spending anything.

## Deploy as an nsite

```sh
node build.mjs --minify
nsyte deploy ./site --no-config -i --sec <site-key-hex> \
  -r wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net \
  -s https://blossom.primal.net,https://nostr.download \
  --fallback index.html --use-fallbacks
```

Use a key dedicated to the site, not a personal one: everyone who follows the
site key receives its manifest updates.

## Layout

| path | what |
|---|---|
| `src/events.js` | NIP-52 model, the dedup convention, canonical-copy choice |
| `src/nostr.js` | relays, identity (NIP-07 or a guest key), queries, publishing |
| `src/ppq.js` | PPQ account, balance, chat, Lightning top-up |
| `src/scout.js` | the paid run: catalogues, the budgeted harvest loop, dedup, event building |
| `src/mockppq.js` | fake PPQ behind `?mock=1`, so the paid path is testable |
| `src/main.js` | the page |
| `DESIGN.md` | the conventions this page relies on and why |
