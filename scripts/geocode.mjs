// City -> [latitude, longitude] resolution for the visitor globe.
//
// Umami reports city names with no coordinates, so the names have to be
// geocoded at build time. Design constraints: free, no API key, and no
// dependency the build cannot survive losing.
//
// Primary: Open-Meteo's geocoding API (GeoNames-backed, keyless, 10k calls/day,
// CC-BY). Fallback: Photon (Komoot, keyless, OSM-backed) which indexes small
// municipalities Open-Meteo misses. If both fail, the caller falls back to the
// country centroid, so a city that will not resolve degrades to a dot in the
// right country rather than disappearing.
//
// Results are cached in data/geo-cache.json and committed by CI, so steady-state
// runs make zero network calls. Misses are cached too, with a retry window, so a
// name that cannot be resolved is not re-queried on every single build.
//
// Two non-obvious hazards this handles, both verified against the live APIs:
//   * Open-Meteo will answer an anglicised name with a confident, wrong result
//     on another continent ("Bangalore" -> Pakistan, "Kiev" -> Russia). Passing
//     countryCode and then asserting the returned country matches turns those
//     into honest nulls.
//   * Its ranking is not by population ("Springfield" returns Missouri, then
//     Illinois, then the larger Massachusetts), so results[0] is not safe. We
//     re-rank by feature class, then population.

const OPEN_METEO = 'https://geocoding-api.open-meteo.com/v1/search';
const PHOTON = 'https://photon.komoot.io/api/';

const MISS_RETRY_DAYS = 30;
const THROTTLE_MS = 250;
// Bound on new lookups per run, so a malformed Umami response cannot fan out
// into thousands of geocoder calls.
const MAX_LOOKUPS_PER_RUN = 60;

// Prefer real settlements over administrative fictions and airports.
const FEATURE_RANK = { PPLC: 0, PPLA: 1, PPLA2: 2, PPLA3: 3, PPLA4: 4, PPL: 5 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalise(name) {
  return String(name).normalize('NFC').trim().toLowerCase();
}

export function cacheKey(city, countryCode) {
  // Keyed on (city, country) because bare names collide across countries:
  // Umami really does report both Paris/FR and Paris/US, London/GB and
  // London/CA. Keying on the name alone would merge them.
  return `${normalise(city)}|${String(countryCode || '').toUpperCase()}`;
}

// Name variants to try, in order. Open-Meteo does not fold the German sharp s,
// and GeoNames itself stores e.g. "Dusslingen", so ss must be tried explicitly.
export function nameVariants(city) {
  const raw = String(city).normalize('NFC').trim();
  const seen = new Set();
  const out = [];
  for (const v of [raw, raw.replace(/ß/g, 'ss'), stripDiacritics(raw)]) {
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      // Photon and Nominatim-family services expect an identifying agent.
      'user-agent': 'adhirajghosh.github.io visitor-globe (+https://adhirajghosh.github.io)',
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// Exported for testing: this is the guard that stops a confidently wrong answer
// on another continent from becoming a dot on the map. Asserting the country
// rather than trusting results[0] is the whole point.
export function pickBestResult(results, countryCode) {
  const cc = String(countryCode || '').toUpperCase();
  const matching = (Array.isArray(results) ? results : [])
    .filter((r) => String(r?.country_code).toUpperCase() === cc);
  if (!matching.length) return null;

  matching.sort((a, b) => {
    const fa = FEATURE_RANK[a.feature_code] ?? 9;
    const fb = FEATURE_RANK[b.feature_code] ?? 9;
    if (fa !== fb) return fa - fb;
    return (b.population || 0) - (a.population || 0);
  });

  const best = matching[0];
  const lat = Number(best.latitude);
  const lon = Number(best.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon)
    ? [+lat.toFixed(4), +lon.toFixed(4)]
    : null;
}

async function queryOpenMeteo(name, countryCode) {
  const url = new URL(OPEN_METEO);
  url.searchParams.set('name', name);
  url.searchParams.set('count', '10');
  // Undocumented but verified: constrains results to one country, and is what
  // makes the anglicised-name misresolution safe.
  url.searchParams.set('countryCode', countryCode);

  const data = await getJson(url);
  return pickBestResult(data?.results, countryCode);
}

async function queryPhoton(name, countryCode) {
  const url = new URL(PHOTON);
  url.searchParams.set('q', name);
  url.searchParams.set('limit', '5');
  url.searchParams.set('layer', 'city');

  const data = await getJson(url);
  for (const f of data?.features || []) {
    const cc = String(f?.properties?.countrycode || '').toUpperCase();
    const [lon, lat] = f?.geometry?.coordinates || [];
    if (cc === countryCode && Number.isFinite(lat) && Number.isFinite(lon)) {
      return [+lat.toFixed(4), +lon.toFixed(4)];
    }
  }
  return null;
}

export function createGeocoder(cache) {
  const hits = cache.hits ||= {};
  const misses = cache.misses ||= {};
  const today = new Date().toISOString().slice(0, 10);
  const stats = { cached: 0, resolved: 0, failed: 0, skipped: 0, capped: 0 };
  let lookups = 0;

  function missIsFresh(entry) {
    if (!entry?.lastTried) return false;
    const age = (Date.parse(today) - Date.parse(entry.lastTried)) / 86400000;
    return Number.isFinite(age) && age < MISS_RETRY_DAYS;
  }

  return {
    stats,

    async resolve(city, countryCode) {
      const cc = String(countryCode || '').toUpperCase();
      if (!city || !/^[A-Z]{2}$/.test(cc)) return null;

      const key = cacheKey(city, cc);
      if (Array.isArray(hits[key])) { stats.cached++; return hits[key]; }
      if (missIsFresh(misses[key])) { stats.skipped++; return null; }

      if (lookups >= MAX_LOOKUPS_PER_RUN) {
        stats.capped++;
        return null;
      }
      lookups++;

      let coords = null;
      let reason = 'no-results';
      try {
        for (const variant of nameVariants(city)) {
          coords = await queryOpenMeteo(variant, cc);
          if (coords) break;
          await sleep(THROTTLE_MS);
        }
        if (!coords) {
          coords = await queryPhoton(city, cc);
        }
      } catch (err) {
        reason = `error: ${err.message}`.slice(0, 120);
      }
      await sleep(THROTTLE_MS);

      if (coords) {
        hits[key] = coords;
        delete misses[key];
        stats.resolved++;
        return coords;
      }

      const prior = misses[key]?.tries || 0;
      misses[key] = { tries: prior + 1, lastTried: today, reason };
      stats.failed++;
      return null;
    },

    // Report how many lookups were dropped by the per-run cap, so a truncated
    // run never reads as a complete one.
    get cappedRemaining() { return stats.capped; },
  };
}

export { MAX_LOOKUPS_PER_RUN };
