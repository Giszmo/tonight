# Tonight

A single static page that answers "what is on near me?" from public nostr relays,
and lets whoever wants fresher data pay for one scouting run in their own browser.

- **Reading is free.** Anything a previous visitor scouted is on the relays as
  [NIP-52](https://github.com/nostr-protocol/nips/blob/master/52.md) events.
- **Scouting is on demand and visitor-paid.** No cron, no scraper, no server of
  ours. A run is one [PPQ.ai](https://ppq.ai) call with web search, paid from an
  anonymous credit the page creates on first use and tops up over Lightning.
  Roughly $0.02–0.03 per run, so $1 is 30–50 runs.
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
npm run build        # bundles src/ -> site/app.js
npm test             # dedup + candidate-parsing unit tests
npm run e2e          # drives site/ in headless Chromium against a throwaway relay
npx serve site       # or any static server
```

`npm run e2e` starts an in-memory relay, seeds a Munich evening (including one
concert published twice by two scouts), and checks that the page renders it,
collapses the duplicate, counts RSVPs, publishes a signed RSVP when you click
"going", and opens a real PPQ Lightning invoice when the balance is empty.
Screenshots land in `.scratch/shots/`.

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
| `src/scout.js` | the paid run: prompt, candidate parsing, event building |
| `src/main.js` | the page |
| `DESIGN.md` | the conventions this page relies on and why |
