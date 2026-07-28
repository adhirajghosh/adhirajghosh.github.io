#!/usr/bin/env node
// Builds data/visitor-globe.json — city-level dots plus country and city stats
// for the globe on the homepage.
//
// Run by .github/workflows/static.yml on every deploy and on a daily schedule,
// so the globe stays current without any server of its own.
//
// Auth uses Umami's *share token*, not an API key: API keys are gated behind
// Umami Cloud's Pro plan, whereas share URLs work on the free Hobby plan. The
// flow is two steps:
//
//   1. GET  <base>/share/<slug>            -> { websiteId, token, parameters }
//   2. GET  <base>/websites/<id>/metrics   with both of
//            x-umami-share-token: <token>
//            x-umami-share-context: 1      (required since Umami v3; a token
//                                           sent without it is rejected 401)
//
// Note the base URL. Umami Cloud runs the app per region under a basePath, so
// the API is at cloud.umami.is/analytics/<region>/api -- NOT api.umami.is/v1
// (that is the API-key endpoint) and not cloud.umami.is/api. Pointing this at
// the wrong region is the nastiest failure mode available: the bootstrap call
// still returns 200 with a usable token, because share records live in a shared
// control plane, but every metrics call then comes back empty rather than
// erroring. Hence the explicit emptiness check at the end.
//
// Required env:
//   UMAMI_SHARE_SLUG   trailing path segment of the share URL from
//                      Umami -> Websites -> Edit -> Share URL
// Optional env:
//   UMAMI_REGION       us (default) | eu
//   UMAMI_BASE_URL     full override of the API base
//   UMAMI_WEBSITE_ID   if set, cross-checked against the bootstrap response so
//                      a slug pasted from the wrong site fails loudly instead
//                      of quietly rendering someone else's traffic
//   UMAMI_START        ISO date to count from; defaults to 2024-01-01
//
// Usage: UMAMI_SHARE_SLUG=... node scripts/build-visitor-globe.mjs

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CENTROIDS, resolveCountry } from './country-centroids.mjs';
import { createGeocoder } from './geocode.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/visitor-globe.json');
const CACHE = resolve(ROOT, 'data/geo-cache.json');

const SLUG = process.env.UMAMI_SHARE_SLUG;
const REGION = process.env.UMAMI_REGION || 'us';
const BASE_URL = (process.env.UMAMI_BASE_URL
  || `https://cloud.umami.is/analytics/${REGION}/api`).replace(/\/$/, '');
const EXPECT_WEBSITE_ID = process.env.UMAMI_WEBSITE_ID;

// cobe marker sizes. Log-scaled between these bounds: city session counts have a
// brutal long tail (typically ~17% of cities have exactly one session), so a
// linear scale would render everything except the top few as invisible.
const MIN_SIZE = 0.022;
const MAX_SIZE = 0.09;
// Upper bound on dots drawn. Well above the ~100-200 cities a homepage of this
// size produces; if it ever trips, the shortfall is logged rather than hidden.
const MAX_MARKERS = 400;

function fail(message) {
  console.error(`visitor-globe: ${message}`);
  process.exit(1);
}

// Umami v2 wrapped stats as {visitors: {value, prev}}; v3 returns flat numbers.
// Accept either so a version bump on Umami's side cannot silently zero the
// totals shown under the globe.
function toNumber(value) {
  if (value && typeof value === 'object') return Number(value.value) || 0;
  return Number(value) || 0;
}

async function apiGet(path, { params = {}, headers = {} } = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!res.ok) {
    throw new Error(
      `GET ${url.pathname} -> ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  return res.json();
}

function scaleSize(sessions, logMax) {
  if (logMax <= 0) return MIN_SIZE;
  return +(MIN_SIZE + (MAX_SIZE - MIN_SIZE) * (Math.log1p(sessions) / logMax)).toFixed(4);
}

async function readCache() {
  try {
    return JSON.parse(await readFile(CACHE, 'utf8'));
  } catch {
    return { version: 1, hits: {}, misses: {} };
  }
}

async function main() {
  if (!SLUG) fail('UMAMI_SHARE_SLUG is not set. See VISITOR-MAP-SETUP.md.');

  const share = await apiGet(`/share/${encodeURIComponent(SLUG)}`);
  const websiteId = share?.websiteId;
  const token = share?.token;
  if (!websiteId || !token) {
    throw new Error(`share bootstrap returned no websiteId/token: ${JSON.stringify(share).slice(0, 200)}`);
  }
  if (EXPECT_WEBSITE_ID && websiteId !== EXPECT_WEBSITE_ID) {
    fail(`share slug points at website ${websiteId}, expected ${EXPECT_WEBSITE_ID}. Wrong share URL?`);
  }
  // /metrics needs one of overview/events/sessions/... enabled on the share,
  // and /stats needs overview or compare. The default share is {overview:true}.
  if (share.parameters && !share.parameters.overview && !share.parameters.compare) {
    console.warn(
      'visitor-globe: this share URL does not expose the overview section; ' +
      'metrics may come back empty. Enable it in Umami if the globe stays hidden.',
    );
  }

  const headers = { 'x-umami-share-token': token, 'x-umami-share-context': '1' };
  const startAt = Date.parse(process.env.UMAMI_START || '2024-01-01T00:00:00Z');
  const endAt = Date.now();
  const params = { startAt: String(startAt), endAt: String(endAt) };

  const [countryRows, cityRows, stats] = await Promise.all([
    apiGet(`/websites/${websiteId}/metrics`, { params: { ...params, type: 'country', limit: '500' }, headers }),
    apiGet(`/websites/${websiteId}/metrics`, { params: { ...params, type: 'city', limit: '500' }, headers }),
    apiGet(`/websites/${websiteId}/stats`, { params, headers }),
  ]);
  for (const [name, rows] of [['country', countryRows], ['city', cityRows]]) {
    if (!Array.isArray(rows)) {
      throw new Error(`expected an array from /metrics?type=${name}, got ${JSON.stringify(rows).slice(0, 200)}`);
    }
  }

  // NOTE: Umami's `y` is count(distinct session_id) — sessions, not visitors.
  // Its SQL also excludes rows whose geo field is empty, so unresolved traffic
  // is absent from these lists entirely rather than appearing as "unknown".
  // Coverage therefore has to be derived by differencing, below.
  const countries = [];
  for (const row of countryRows) {
    const sessions = Number(row?.y) || 0;
    const code = resolveCountry(row?.x);
    if (sessions > 0 && code) countries.push({ country: code, sessions });
  }
  countries.sort((a, b) => b.sessions - a.sessions);

  const cities = [];
  for (const row of cityRows) {
    const sessions = Number(row?.y) || 0;
    const code = resolveCountry(row?.country);
    const name = typeof row?.x === 'string' ? row.x.trim() : '';
    if (sessions > 0 && code && name) cities.push({ city: name, country: code, sessions });
  }
  cities.sort((a, b) => b.sessions - a.sessions);

  // Geocode cities, newest-largest first so the per-run lookup cap spends its
  // budget on the cities that actually matter visually.
  const cache = await readCache();
  const geocoder = createGeocoder(cache);
  const placed = [];
  const unplacedByCountry = new Map();

  for (const entry of cities) {
    const location = await geocoder.resolve(entry.city, entry.country);
    if (location) placed.push({ ...entry, location });
    else {
      unplacedByCountry.set(entry.country, (unplacedByCountry.get(entry.country) || 0) + entry.sessions);
    }
  }

  // Sessions Umami placed in a country but not in any city, plus cities that
  // would not geocode, both collapse to a single dot on the country centroid.
  // They are shown rather than dropped, because dropping them would understate
  // the map and quietly disagree with the totals underneath it.
  const citySessionsByCountry = new Map();
  for (const c of cities) {
    citySessionsByCountry.set(c.country, (citySessionsByCountry.get(c.country) || 0) + c.sessions);
  }
  for (const { country, sessions } of countries) {
    const cityCovered = citySessionsByCountry.get(country) || 0;
    const remainder = sessions - cityCovered;
    if (remainder > 0) {
      unplacedByCountry.set(country, (unplacedByCountry.get(country) || 0) + remainder);
    }
  }

  const countryFallbacks = [...unplacedByCountry.entries()]
    .filter(([code, sessions]) => CENTROIDS[code] && sessions > 0)
    .map(([code, sessions]) => ({ country: code, sessions, location: CENTROIDS[code], approximate: true }));

  const allDots = [...placed, ...countryFallbacks].sort((a, b) => b.sessions - a.sessions);
  const truncated = Math.max(0, allDots.length - MAX_MARKERS);
  const drawn = allDots.slice(0, MAX_MARKERS);
  const logMax = Math.log1p(Math.max(1, ...drawn.map((d) => d.sessions)));

  const totalSessions = toNumber(stats?.visits) || toNumber(stats?.sessions);
  const payload = {
    generatedAt: new Date(endAt).toISOString(),
    since: new Date(startAt).toISOString().slice(0, 10),
    totals: {
      visitors: toNumber(stats?.visitors),
      pageviews: toNumber(stats?.pageviews),
      sessions: totalSessions,
      countries: countries.length,
      cities: cities.length,
    },
    // Sessions on the map versus sessions Umami could place in a country at all.
    // Surfaced so the page can be honest about how much traffic is represented.
    coverage: {
      mappedSessions: drawn.reduce((n, d) => n + d.sessions, 0),
      countrySessions: countries.reduce((n, c) => n + c.sessions, 0),
      citiesGeocoded: placed.length,
      citiesTotal: cities.length,
      markersTruncated: truncated,
    },
    countries: countries.slice(0, 12),
    cities: cities.slice(0, 12),
    markers: drawn.map((d) => ({ location: d.location, size: scaleSize(d.sessions, logMax) })),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  cache.version = 1;
  await writeFile(CACHE, `${JSON.stringify(cache, null, 2)}\n`);

  const g = geocoder.stats;
  console.log(
    `visitor-globe: ${countries.length} countries, ${cities.length} cities ` +
    `(${placed.length} geocoded), ${drawn.length} dots drawn -> data/visitor-globe.json`,
  );
  console.log(
    `visitor-globe: geocoder cached=${g.cached} resolved=${g.resolved} ` +
    `failed=${g.failed} skipped-recent-miss=${g.skipped}`,
  );
  if (g.capped) {
    console.warn(
      `visitor-globe: ${g.capped} city lookup(s) hit the per-run cap and were not ` +
      'geocoded this run; they fell back to their country dot and will be retried next run.',
    );
  }
  if (truncated) {
    console.warn(`visitor-globe: ${truncated} dot(s) beyond the ${MAX_MARKERS} marker limit were not drawn.`);
  }
  if (!countries.length && !totalSessions) {
    console.warn(
      `visitor-globe: no data returned for region "${REGION}". If your Umami account is ` +
      'in the other region, set UMAMI_REGION accordingly — a region mismatch returns ' +
      'empty results rather than an error.',
    );
  }
}

main().catch((err) => fail(err.message));
