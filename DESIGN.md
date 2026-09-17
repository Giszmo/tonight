# Conventions

Three things have to be agreed between publishers for a city listing to work on
nostr. None of them is in a NIP yet; all three are cheap to adopt.

## 1. Multi-precision geohashes

Relay tag filters are exact-match, so `#g` cannot be queried by prefix. A
publisher therefore emits every prefix of the venue geohash from precision 2 to
8 (`src/events.js:buildEventTags`), and a reader asks for precisions 3–5 around
the place it is showing (`src/nostr.js:fetchCityEvents`) — roughly a 20–150 km
net — then filters by real distance client-side. City name tags (`t`) are kept
as a second path for publishers who only tag text, plus a broad recent sweep
while the global NIP-52 volume is small enough for that to be free.

## 2. Dedup: one real-world event, one identity

The same concert appears at the venue, at the ticket shop and in the city
magazine. Without a convention, endorsements scatter over three copies and the
list shows each event three times.

`d = sha256(normalisedTitle | normalisedVenue | startRoundedTo15min)[:32]`

Normalisation folds umlauts to `ae/oe/ue/ss`, strips punctuation and drops
filler words (`live`, `konzert`, `presents`, articles). Two publishers who
describe an event the same way land on the same address suffix, so any client
collapses the copies by address alone.

Wording differs more often than not, so a reader should also cluster on content
(`src/events.js:sameEvent`): same venue (or within 300 m) and start within 30
minutes, plus a title-token containment of 0.6 — that is what merges
"Münchner Kammerorchester: Schubert" (magazine) with
"Kammerorchester München – Schubert (Prinzregententheater)" (ticket shop). With
no venue on either side, only near-identical titles (Jaccard ≥ 0.8) collapse.

Ranking inside a group decides which copy is canonical. Today that is "the copy
with the most signal" (source URL, image, summary, end time). The intended
order is organiser-claimed (a key whose NIP-05 domain matches the source) >
human-signed > scout bot; the first tier needs an organiser claim path that does
not exist yet.

## 3. Source catalogues — kind 31121 (provisional)

A city's events are not scattered evenly over the web; they sit in a handful of
catalogues — the what-is-on magazine, the municipal calendar, the regional
ticket platform, the programme pages of the big houses. Finding that handful
costs a paid search, and it is the same answer for everybody, so it belongs on
the relays rather than in one visitor's session:

```
kind: 31121 (parameterised replaceable)
tags: d <host+path>, r <url>, title <name>, source_kind <magazine|city|tickets|venue|…>,
      summary <one line>, t <city-slug>, g <geohash prefixes>, alt <text>
```

A run reads the registry first (`fetchSources`) and spends its money on events.
The discovery call happens when a city has no known catalogues, or when the
visitor ticks "also look for catalogues we do not know yet" — that call is told
which hosts we already have and asked for others, and only genuinely new ones
are published back. The page ticks that box by itself for a city with fewer
than four known catalogues or a registry older than 30 days.

Several scouts publish overlapping sets; the reader keeps one entry per host,
the most recently confirmed. A visitor who only wants a venue watched can
publish one of these without running anything.

## 4. Scout run records — kind 2121 (provisional)

Without a cron, a visitor has to be able to see whether a city is stale and what
a refresh costs before paying for one. Every run publishes a regular event:

```
kind: 2121
tags: t <city-slug>, g <geohash prefixes>, found <n>, published <n>,
      cost_usd <measured>, budget_usd <cap the visitor set>, calls <n>,
      sources <n>, model <id>, window <from> <to>, alt <text>
content: human-readable one-liner
```

`cost_usd` is measured, not estimated: the page reads the PPQ balance before and
after the call and writes the difference. The price shown on the button is the
median of the last five runs for that city, so the estimate improves by itself
and stays honest about the model people actually use.

Kind 2121 is unassigned in the NIPs kind registry as of 2026-09-17 and is
app-specific here. If this pattern survives contact with reality it belongs in a
NIP together with the dedup `d` convention.

`found` is now new candidates rather than everything the model said: an event
the city already has never becomes a candidate (see below), so `found` divided
by `cost_usd` is the number the next visitor actually cares about — new events
per cent — and it is what the budget sheet quotes.

## 5. What one run does

A run is not one search. One search returns the four events that happened to
rank, which is how the first version behaved — and asking a search-backed model
to "walk the listing" does not fix it, because `:online` is a web search and the
model never opens the page. It answers from snippets, so a portal with 44 events
that day came back with one.

1. **Catalogues.** From the registry (free), or one paid call that finds them.
   Discovery asks for the page that shows the dated listing, not the section
   front page, and asks for cinema by name — a city calendar carries concerts
   and theatre and no films at all.
2. **Fetch the page.** `src/reader.js` fetches each catalogue page directly
   first and through `r.jina.ai` otherwise; the reader renders the page, returns
   markdown and reflects the caller's origin, which is what makes this possible
   from a static site. Fetching costs nothing, so the visitor's money goes into
   extraction only.
3. **Extract from that text.** The model is given the page and forbidden to
   search or recall. A page that turns out to be a hub answers with the listing
   URLs it points at (same host only) and those get walked instead; a paginated
   listing answers with its own `next_url`. The page that actually held events is
   what goes back into the registry.
4. **Three at a time.** Catalogues do not depend on each other, so the visitor
   waits for the slowest rather than the sum. A page that will not load falls
   back to asking the model, which is all the run could ever do before.
5. **One open-web pass** at the end, alone, for what no catalogue lists: it is
   the weakest pass, so it gets the money the catalogues left.
6. **Stop on the visitor's budget**, never on a fixed call count: the cost of a
   job is reserved when it starts, not when its call goes out, so three workers
   cannot each decide they fit while the other two are still fetching. Concurrent
   calls cannot be priced individually from a balance delta, but the total can —
   the balance is absolute, so `startBalance - balance` is what the account was
   really charged — and per-call figures are that batch's share of it.

Everything the city already has is fed into every prompt as "skip these", and
everything that comes back is filtered again client-side with the same
`sameEvent` matcher the listing uses — the prompt saves tokens, the filter is
what actually holds. Candidates are deduplicated against each other too, so the
same gala listed by the magazine and the ticket shop is one candidate.

## 6. Times belong to the city, not to the reader

A listing says "20:00". Which 20:00 depends on the city, and the visitor may be
looking at Munich from Mexico — which is the whole point of a city picker. So
every window we send is stated in UTC, and the model is asked to answer in the
city's own wall clock plus the IANA zone it used (`"tz": "Europe/Berlin"`).
Timestamps come back through `Intl` in that zone, and the published event
carries it as `start_tzid`. Without a `tz` the browser's zone is the fallback,
which is right only for a visitor who is already there.

## Money and keys

- PPQ accounts are created anonymously from the page (`POST /accounts/create`).
  The `credit_id` **is** the login at ppq.ai; the page shows it prominently and
  links `https://ppq.ai/sessions/<credit_id>` so leftover credit is never
  stranded in one browser's localStorage. Someone who already has PPQ credit can
  paste their credit id instead, and the page mints a capped sub-key
  (`POST /keys` with `x-credit-id`, `usage_limit_usd`), so it can never spend
  more than the cap.
- An empty balance shows up as HTTP 402 from PPQ. That is the only trigger for
  the top-up sheet; nothing else needs detecting.
- Identity: a NIP-07 extension if there is one, otherwise a guest key generated
  in the browser. A guest key is a real nostr identity — the settings sheet shows
  the nsec so it can be kept — which means events published here carry a
  reputation that can be followed, rather than being anonymous noise.

## Testing the paid path without paying

`?mock=1` swaps the PPQ client for `src/mockppq.js`: fake catalogues, fake
harvests with pagination, an invoice that pays itself after five seconds, and a
ticket shop that deliberately re-lists an event the city already has. It exists
so the parts that only happen after money changes hands — the budget, the run
log, the candidate review, the dedup, the confetti — are driven end to end by
`npm run e2e` in a real browser against a throwaway relay. It never touches the
network and it is not reachable without the query parameter.

## Where the events that are missing actually are

Three measurements, all of them against the live web:

1. **A listing can name an event and not date it.**
   `cartazculturallisboa.pt/cinema-em-lisboa` is 204 links and **one clock time in
   the whole page**: the times are on each film's own page. A listing like that is
   unextractable however well it was found, so it is now allowed to answer with
   `detail_urls` — the entries it can see but cannot date. Those pages are opened,
   and they go to the model **in one call for all of them**, not one call each,
   capped at three listings a run.
2. **Some pages carry the answer in machine-readable form already.** Every ma.to
   event page has a schema.org `Event` with `startDate` down to the minute and its
   UTC offset. Reading it costs no call and cannot hallucinate. It needs the HTML,
   though: the reader returns markdown and `htmlToText` strips `<script>`, so it is
   a second request for the same page (`x-return-format: html`, same open CORS) —
   and probing every page speculatively earned a run a wall of 429s from the reader
   we all share, taking its *text* fetches down with it. So a listing is probed only
   after it has come back empty, and the run stops asking once the reader refuses.
   Counted before building it: of sixteen event pages across Lisbon and Munich,
   only ma.to's event pages and Eventbrite's city listing have one. A free exact
   bonus where it exists, never the reason a page is read.
3. **Discovery only finds what ranks.** No Lisbon run ever surfaced ma.to, which
   had twelve films on that evening in a city where our run published two, and
   which covers 84 cities behind one predictable URL. Aggregators that publish their own
   list of cities do not need a search at all — `SEED_CATALOGUES` reads that list
   and goes straight to the page, for nothing. Matching the city to their slug is
   the whole difficulty: the picker says "Lisboa" because OpenStreetMap does and
   the aggregator says "lisbon" because it is written in English, so the match is
   exact-or-one-edit with the first five letters agreeing, and an ambiguous match
   is no match at all.

And the fourth, which is not a trick: **anyone can add a catalogue**. The registry
is a nostr event, so a page somebody local already reads every week goes in once
and every future run in that city reads it — the same mechanism the seeds use and
the same one a run's own findings use.

## Known limits

- Coverage is bound by what a catalogue page shows to a fetcher. Server-rendered
  listings extract well; pages that build their programme in the browser do not,
  and cinema is the worst case — kino.de returns no showtimes even through a
  JS-rendering reader, so a city's film programme depends on finding a
  server-rendered source. ICS and RSS on venue pages are within reach through the
  same reader and are not yet used.
- The reader is a third party. It is a fallback with a direct fetch in front of
  it, and a page that will not load degrades to a web search rather than
  failing, but a run's completeness depends on a service nobody here operates.
  It also *renders*, and that is load-bearing: ma.to writes its times into a
  hydration payload, so the unrendered HTML has none and the reader's markdown
  has all of them. A visitor is always on the reader path, because almost no
  catalogue sends `access-control-allow-origin`; a node harness is on neither
  unless it is told to be (`allowDirect: false`, which `test/live-run.mjs` sets).
- Organiser claims and web-of-trust ranking are specified above but not built;
  the page counts raw endorsements and marks the ones from people you follow.
- No recurrence support (NIP-52 has none yet).
- A harvest is bound by how much of a page fits in one call (60 000 characters,
  cut at the end) and by how many pages a run follows: four of one listing, six
  off one hub. A thousand-entry week still arrives over several runs by several
  visitors, which is why nothing is re-collected twice.
