# Visitor map setup

The old RevolverMaps widget **shut down on 15 November 2024**. Its domain no
longer has a web server, so the widget could never render again and the visitor
history it held is gone. It has been removed from `index.html` and replaced with
the two pieces below.

The split matters: **Umami** is what actually counts visitors and geolocates
them, and **the globe** is only a read-only picture of that data. The globe
cannot work until Umami is collecting.

---

## Step 1 — Turn on visitor counting — DONE

Account created on Umami Cloud (US region) and the tracker is live at the bottom
of `index.html` with website ID `905a7464-541f-4519-bbab-347c7be4f8e0`.

This alone gives a dashboard with country, region and city breakdowns, a world
map, referrers, and pages — everything RevolverMaps used to show, and more.

Two notes on it:

- `data-domains="adhirajghosh.github.io"` on the script tag keeps forks and local
  copies out of the stats. **If this site ever moves to a custom domain, that
  attribute must be updated or counting will silently stop.**
- The **US region** was chosen. That is fine. Umami Software is a US company
  either way (San Francisco), and its DPA covers EEA/UK/Swiss transfers with
  Standard Contractual Clauses regardless of which region holds the data, so the
  EU region would not have changed the legal basis. What matters for avoiding a
  consent banner is that Umami is cookieless and sets no client-side storage,
  which is region-independent.

Why Umami over the alternatives, briefly:

| | Free | City-level geo | Cookie banner needed | EU hosting |
|---|---|---|---|---|
| **Umami Cloud** | **yes** | **yes** | **no** | **yes** |
| Cloudflare Web Analytics | yes | country only | not stated | no (US) |
| Simple Analytics | yes | country only, permanently | no | yes (NL) |
| Plausible | no ($9/mo) | yes | no | yes (DE) |
| Fathom | no ($15/mo) | yes | no | partly |
| Google Analytics 4 | yes | yes | **yes** | no |
| MapMyVisitors | yes | ~half "unknown" | **yes, per its own terms** | partly |

Umami is the only free option with city-level geolocation, no cookie banner, and
EU hosting at the same time.

**Avoid MapMyVisitors**, which is the most commonly suggested RevolverMaps
replacement. It is the same operation as the ClustrMaps people-search business;
it sets an undisclosed `PHPSESSID` cookie despite advertising "no cookies"; its
own terms make *you* responsible for obtaining GDPR consent; and it publishes
your visitor data — on some sites including raw visitor IP addresses — on public,
search-indexable pages.

---

## Step 2 — Turn on the globe (5 minutes, free)

**API keys are not needed, and must not be used.** Umami gates API keys behind
the Pro plan (`message.api-keys-pro-required` — the message you hit). The globe
instead authenticates with a **share token**, which is ungated on the free plan.

Only **one** secret is needed.

1. In Umami: **Websites → Edit → Enable share URL**. You get a URL like
   `https://cloud.umami.is/share/aB3xY9zQ.../adhirajghosh.github.io`.
   Copy the **slug** — the `aB3xY9zQ...` segment, not the whole URL.
2. In GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**. Name it exactly `UMAMI_SHARE_SLUG` and paste the slug.
   Direct link: <https://github.com/adhirajghosh/adhirajghosh.github.io/settings/secrets/actions>
3. Trigger a deploy — push anything, or **Actions → "Deploy static content to
   Pages" → Run workflow**.

The slug is kept in a secret only because anyone holding it can read your full
Umami dashboard. It is not required for the analytics themselves to work.

Then check the run log for `Refresh visitor globe data`. On success:

```
visitor-globe: 25 countries, 138 cities (131 geocoded), 152 dots drawn -> data/visitor-globe.json
visitor-globe: geocoder cached=0 resolved=131 failed=7 skipped-recent-miss=0
```

### How the city dots are built

Umami reports city **names** with no coordinates, so names are geocoded at build
time by `scripts/geocode.mjs`:

- **Open-Meteo** geocoding (GeoNames-backed, keyless, 10k calls/day, CC-BY) is
  the primary, with **Photon** (Komoot, keyless, OSM-backed) as fallback — it
  indexes small municipalities Open-Meteo misses.
- Results are cached in `data/geo-cache.json`, which CI commits back. Steady-state
  runs make **zero** geocoder calls. Failures are cached too, and retried after
  30 days.
- A city that will not geocode **falls back to its country centroid**, so it still
  appears on the globe rather than vanishing. Sessions Umami placed in a country
  but no city are handled the same way.

Two hazards this deliberately guards against, both reproduced against the live
APIs: Open-Meteo will answer an anglicised name with a confident wrong result on
another continent (`Bangalore` → Pakistan, `Kiev` → Russia), so the country code
is always passed and the returned country asserted; and its ranking is not by
population (`Springfield` returns Missouri before the larger Massachusetts), so
results are re-ranked rather than taking the first.

### Notes and gotchas

- **The counts are sessions, not visitors.** Umami's geo metrics are
  `count(distinct session_id)`. The headline visitor number under the globe comes
  from `/stats` and is genuinely visitors; the per-country and per-city numbers
  are sessions.
- **`UMAMI_REGION` must match your account** — it is pinned to `us` in the
  workflow. A region mismatch is the nastiest failure available: the share
  bootstrap still returns 200 with a working token, then every metrics call comes
  back empty instead of erroring. The build logs a warning if this happens.
- Expect **datacenter artifacts** in the city list — Ashburn (AWS), Falkenstein
  (Hetzner), Council Bluffs and Boardman (Google/AWS), Boydton (Azure). Those are
  cloud egress and VPN exits, not readers. Umami filters bot *user agents*, not
  datacenter IPs, so they are not removed.
- Umami Cloud's free plan retains **6 months**, so this is a rolling window, not
  an all-time total.
- Until the secret exists the build step logs a warning and the deploy continues
  normally. The globe stays hidden while the JSON has no markers, so the page
  never shows an empty frame.

Optional environment overrides:

- `UMAMI_START` — ISO date to count from. Defaults to `2024-01-01`.
- `UMAMI_REGION` — `us` (default) or `eu`.
- `UMAMI_BASE_URL` — full override. Self-hosted Umami uses `https://<host>/api`.

To test locally:

```sh
UMAMI_SHARE_SLUG=... node scripts/build-visitor-globe.mjs
```

---

## About the "unknown location" problem

This was the main complaint about the old widget, and it was **not** an inherent
limit of IP geolocation — it was RevolverMaps' own lookup being stale and
IPv4-only before the service died outright.

Measured against a current MaxMind GeoLite2 database (build date 2026-07-24):

- **Country resolves for ~99–100% of real routable IPs.** On a 20,000-IP random
  sample, only 0.4% had no record at all. This is the part that was broken and is
  now fixed.
- **City is much patchier, and the gap is IPv6.** Same ISP, same customers:
  Deutsche Telekom's IPv4 range resolves to a city 99.9% of the time, its IPv6
  range 1.1% of the time. Vodafone and O2 Germany are fully city-mapped. Mobile
  carrier-grade NAT resolves to a city about 39% of the time. Nothing any
  analytics provider can do fixes this — the underlying database simply has no
  finer data for those blocks.
- **Apple iCloud Private Relay is already handled.** Apple publishes an
  egress-IP-to-location feed (286,949 prefixes, 15,119 cities, 85% IPv6) and
  GeoLite2 consumes it: on a 400-prefix sample, country matched Apple's own
  declared location 100% of the time for IPv6 and 92% for IPv4.
- **VPNs, Tor and datacenter traffic do not produce "unknown"** — they resolve to
  a real city, just the wrong one (the datacenter's). Tor exits land in
  Brandenburg, AWS in Ashburn, Hetzner in Falkenstein.
- **Bots mostly never arrive.** Classic crawlers and AI scrapers fetch HTML
  without executing JavaScript, so a JS beacon like Umami's structurally never
  sees them. Umami also filters known bot user agents by default.

### What city coverage actually looks like in practice

The per-ISP figures above are the pessimistic view. Measured against **live Umami
share dashboards** — real traffic, not synthetic IP samples — city coverage is
much better than those numbers suggest:

| | small site (786 visitors/yr) | high-diversity site |
|---|---|---|
| sessions with a city / sessions with a country | 740/786 = **94.1%** | **95.6%** |
| sessions with a region / with a country | 87.3% | — |
| distinct cities | 138 | 20,000+ |

So **~94–96% of country-placeable sessions also resolve to a city.** A city-level
map will look busy, not sparse. Keep the German-IPv6 caveat in mind, though —
neither measured site was a European academic audience, and that gap is real.

Two consequences worth knowing:

- **The tail is severe.** Roughly 17% of cities have exactly one session, and the
  median city has one. Dot sizes are log-scaled for exactly this reason; a linear
  scale would render everything but the top few invisible.
- **Umami never labels the unknown bucket.** Its SQL contains `and city != ''`, so
  sessions with no resolvable city are dropped from the metrics response entirely
  rather than returned as "unknown". This is why coverage has to be derived by
  differencing city totals against country totals, which is what the `coverage`
  block in `visitor-globe.json` and the fine print under the globe both report.

A city that cannot be geocoded, and any session Umami placed in a country but no
city, is drawn on the country centroid instead — so all such US traffic collapses
to one dot in Kansas. That is deliberate: it keeps the map's totals honest instead
of quietly discarding traffic, and it never claims precision that is not there.
