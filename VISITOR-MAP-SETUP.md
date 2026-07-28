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

## Step 2 — Turn on the globe (optional, 5 minutes)

The globe reads `data/visitor-globe.json`, which is regenerated on every deploy
and once a day by `scripts/build-visitor-globe.mjs`. The Umami API key stays in
GitHub Actions secrets and never reaches the browser.

Only **one** secret is needed. The website ID is already hardcoded in the
workflow, because it is public by design — it ships in `index.html` so the
tracker can identify the site, so hiding it in a secret would gain nothing.

1. In Umami: **Settings → API keys → Create key**. Copy it; it is shown once.
2. In GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**. Name it exactly `UMAMI_API_KEY` and paste the key as the value.
   Direct link: <https://github.com/adhirajghosh/adhirajghosh.github.io/settings/secrets/actions>
3. Trigger a deploy — either push anything, or **Actions → "Deploy static content
   to Pages" → Run workflow**.

Then check the run log for the `Refresh visitor globe data` step. On success it
prints something like:

```
visitor-globe: wrote 12 countries, 995/1052 visitors placed -> data/visitor-globe.json
```

The two numbers differ on purpose: the second is every visitor Umami counted, the
first is the subset with a resolvable country that could be placed on the globe.

The globe needs at least one visitor with a resolvable country before it appears,
so if you have just set this up, give it a little traffic first.

Until both secrets exist the build step logs a warning, writes nothing, and the
deploy continues normally. The globe stays hidden while the JSON has no markers,
so the page never shows an empty frame.

Optional environment overrides, set in the workflow if you want them:

- `UMAMI_START` — ISO date to count from. Defaults to `2024-01-01`.
- `UMAMI_API_URL` — defaults to `https://api.umami.is/v1`. For a self-hosted
  Umami use `https://<your-host>/api`.

To test locally once the secrets exist:

```sh
UMAMI_API_KEY=... UMAMI_WEBSITE_ID=... node scripts/build-visitor-globe.mjs
```

Note that Umami Cloud's free plan retains 6 months of data, so the globe shows a
rolling window rather than a true all-time total.

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

So: expect country to be essentially always known, and city to be known for
roughly half to three-quarters of a European audience. The globe is drawn at
country granularity, which is the level that is reliable.

Because the globe places one marker per country at a country centroid, all US
visitors appear as a single dot in Kansas. That is intentional — it is honest
about the granularity of the underlying data rather than implying precision that
is not there.
