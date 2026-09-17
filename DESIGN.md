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
rank, which is how the first version behaved.

1. **Catalogues.** From the registry (free), or one paid call that finds them.
2. **Walk them.** One call per catalogue, asking for *every* event in the
   window, up to 60 per answer. A catalogue that says `"more": true` and yielded
   something new gets another pass, told where the last one stopped, up to three
   passes.
3. **One open-web pass** at the end, for what no catalogue lists.
4. **Stop on the visitor's budget**, never on a fixed call count: before each
   call the run checks whether the most expensive call so far would still fit
   under the cap, and the cap is itself clamped to the balance. Cost is measured
   from the PPQ balance around every single call.

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

## Known limits

- Coverage is bound by the quality of PPQ's web search (Exa). Ticketed and
  well-marked events come back well; the long tail of club flyers does not. The
  cheap half of the problem — schema.org JSON-LD, ICS and RSS on venue pages —
  needs a fetch the browser cannot do cross-origin, so it stays out of reach
  until there is either a DVM (NIP-90) or an extension doing the fetching.
- Organiser claims and web-of-trust ranking are specified above but not built;
  the page counts raw endorsements and marks the ones from people you follow.
- No recurrence support (NIP-52 has none yet).
- A harvest is bound by what the model will read of a catalogue page. Deep
  pagination is asked for and often delivered, but a thousand-entry week is not
  going to arrive in one run; it arrives over several runs by several visitors,
  which is why nothing is re-collected twice.
