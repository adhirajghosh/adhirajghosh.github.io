#!/usr/bin/env node
// Builds data/visitor-globe.json from the Umami analytics API.
//
// Run by .github/workflows/static.yml on every deploy and on a daily schedule,
// so the globe on the homepage stays current without any server of its own.
// The API key never reaches the browser: it lives in GitHub Actions secrets and
// only this build step sees it. The committed JSON contains nothing but
// per-country visitor counts.
//
// Required env:
//   UMAMI_API_KEY      Umami Cloud API key (Settings -> API keys)
//   UMAMI_WEBSITE_ID   the website's UUID (Settings -> Websites -> Edit)
// Optional env:
//   UMAMI_API_URL      defaults to https://api.umami.is/v1
//                      self-hosted: https://<your-host>/api
//   UMAMI_START        ISO date to count from; defaults to 2024-01-01
//
// Usage: node scripts/build-visitor-globe.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CENTROIDS, resolveCountry } from './country-centroids.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/visitor-globe.json');

const API_URL = (process.env.UMAMI_API_URL || 'https://api.umami.is/v1').replace(/\/$/, '');
const API_KEY = process.env.UMAMI_API_KEY;
const WEBSITE_ID = process.env.UMAMI_WEBSITE_ID;

// cobe marker sizes. Log-scaled between these bounds so one dominant country
// does not swamp every other dot into invisibility.
const MIN_SIZE = 0.03;
const MAX_SIZE = 0.11;

function fail(message) {
  console.error(`visitor-globe: ${message}`);
  process.exit(1);
}

async function apiGet(path, params) {
  const url = new URL(`${API_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetch(url, {
    headers: { 'x-umami-api-key': API_KEY, accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GET ${url.pathname} -> ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

function scaleMarkers(counts) {
  // counts: [{ country, visitors }] sorted desc. Log scale because visitor
  // counts across countries are heavily skewed.
  const max = Math.max(...counts.map((c) => c.visitors));
  const logMax = Math.log1p(max);
  return counts.map(({ country, visitors }) => ({
    location: CENTROIDS[country],
    size: logMax > 0
      ? +(MIN_SIZE + (MAX_SIZE - MIN_SIZE) * (Math.log1p(visitors) / logMax)).toFixed(4)
      : MIN_SIZE,
    country,
    visitors,
  }));
}

async function main() {
  if (!API_KEY || !WEBSITE_ID) {
    fail('UMAMI_API_KEY and UMAMI_WEBSITE_ID must both be set. See VISITOR-MAP-SETUP.md.');
  }

  const startAt = Date.parse(process.env.UMAMI_START || '2024-01-01T00:00:00Z');
  const endAt = Date.now();
  const range = { startAt: String(startAt), endAt: String(endAt) };

  const [countryMetrics, stats] = await Promise.all([
    apiGet(`/websites/${WEBSITE_ID}/metrics`, { ...range, type: 'country', limit: '500' }),
    apiGet(`/websites/${WEBSITE_ID}/stats`, range),
  ]);

  if (!Array.isArray(countryMetrics)) {
    throw new Error(`expected an array from /metrics, got ${JSON.stringify(countryMetrics).slice(0, 200)}`);
  }

  const counts = [];
  const unresolved = [];
  for (const row of countryMetrics) {
    const visitors = Number(row?.y) || 0;
    if (visitors <= 0) continue;
    const country = resolveCountry(row?.x);
    if (country) counts.push({ country, visitors });
    else unresolved.push(`${JSON.stringify(row?.x)} (${visitors})`);
  }
  counts.sort((a, b) => b.visitors - a.visitors);

  // Umami reports visitors it could not geolocate with an empty/null country.
  // Those are surfaced here rather than silently dropped, so a sudden rise in
  // unplaceable traffic is visible in the build log instead of just thinning
  // out the globe.
  if (unresolved.length) {
    console.warn(`visitor-globe: ${unresolved.length} row(s) had no usable country: ${unresolved.join(', ')}`);
  }

  const payload = {
    generatedAt: new Date(endAt).toISOString(),
    since: new Date(startAt).toISOString().slice(0, 10),
    // Site-wide totals from /stats, which counts every visitor including the
    // ones with no resolvable country. placedVisitors is the subset actually
    // drawn on the globe, so the two numbers are deliberately not the same.
    totalVisitors: Number(stats?.visitors?.value) || 0,
    totalPageviews: Number(stats?.pageviews?.value) || 0,
    totalCountries: counts.length,
    placedVisitors: counts.reduce((sum, c) => sum + c.visitors, 0),
    markers: scaleMarkers(counts.length ? counts : []),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(
    `visitor-globe: wrote ${counts.length} countries, ` +
    `${payload.placedVisitors}/${payload.totalVisitors} visitors placed -> data/visitor-globe.json`,
  );
}

main().catch((err) => fail(err.message));
