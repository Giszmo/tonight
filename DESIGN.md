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

## 3. Scout run records — kind 2121 (provisional)

Without a cron, a visitor has to be able to see whether a city is stale and what
a refresh costs before paying for one. Every run publishes a regular event:

```
kind: 2121
tags: t <city-slug>, g <geohash prefixes>, found <n>, published <n>,
      cost_usd <measured>, model <id>, window <from> <to>, alt <text>
content: human-readable one-liner
```

`cost_usd` is measured, not estimated: the page reads the PPQ balance before and
after the call and writes the difference. The price shown on the button is the
median of the last five runs for that city, so the estimate improves by itself
and stays honest about the model people actually use.

Kind 2121 is unassigned in the NIPs kind registry as of 2026-09-17 and is
app-specific here. If this pattern survives contact with reality it belongs in a
NIP together with the dedup `d` convention.

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

## Known limits

- Coverage is bound by the quality of PPQ's web search (Exa). Ticketed and
  well-marked events come back well; the long tail of club flyers does not. The
  cheap half of the problem — schema.org JSON-LD, ICS and RSS on venue pages —
  needs a fetch the browser cannot do cross-origin, so it stays out of reach
  until there is either a DVM (NIP-90) or an extension doing the fetching.
- Organiser claims and web-of-trust ranking are specified above but not built;
  the page counts raw endorsements and marks the ones from people you follow.
- No recurrence support (NIP-52 has none yet).
