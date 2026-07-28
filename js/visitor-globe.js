// Rotating visitor globe for the homepage — the replacement for the RevolverMaps
// widget, which shut down in November 2024.
//
// Data comes from data/visitor-globe.json, regenerated at deploy time by
// scripts/build-visitor-globe.mjs from the Umami analytics API. Nothing here
// tracks anyone: the page-view beacon is a separate script in index.html, and
// this file only reads an already-aggregated, per-country JSON file.
//
// The widget stays hidden unless it has both WebGL and real data, so a failed
// fetch or an empty dataset leaves no broken frame on the page.

import createGlobe from './cobe.min.js';

const DATA_URL = 'data/visitor-globe.json';

// cobe's documented light-theme preset, with markers in the site's accent
// colour (#f09228, the link hover colour in stylesheet.css).
const GLOBE_STYLE = {
  dark: 0,
  diffuse: 1.2,
  mapSamples: 16000,
  mapBrightness: 6,
  baseColor: [1, 1, 1],
  markerColor: [0.941, 0.573, 0.157],
  glowColor: [1, 1, 1],
};

const ROTATION_PER_FRAME = 0.0035;
const MAX_SIZE = 260;
const MIN_SIZE = 180;

const root = document.getElementById('visitor-globe');
if (root) init(root).catch(() => {});

function hasWebGL() {
  const probe = document.createElement('canvas');
  return Boolean(probe.getContext('webgl2') || probe.getContext('webgl'));
}

function flagEmoji(code) {
  // ISO alpha-2 -> regional indicator symbols, e.g. "DE" -> 🇩🇪
  return /^[A-Z]{2}$/.test(code)
    ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
    : '';
}

function countryName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

function measure(root) {
  const available = root.clientWidth || MAX_SIZE;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.floor(available)));
}

async function init(root) {
  if (!hasWebGL()) return;

  const res = await fetch(DATA_URL, { cache: 'no-cache' });
  if (!res.ok) return;
  const data = await res.json();

  const markers = (data.markers || []).filter(
    (m) => Array.isArray(m.location) && m.location.length === 2,
  );
  if (!markers.length) return;

  root.hidden = false;
  render(root, data, markers);
}

function render(root, data, markers) {
  const canvas = root.querySelector('canvas');
  const caption = root.querySelector('[data-globe-caption]');
  const list = root.querySelector('[data-globe-countries]');

  let size = measure(root);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;

  const globe = createGlobe(canvas, {
    ...GLOBE_STYLE,
    width: size,
    height: size,
    phi: 0,
    theta: 0.25,
    devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    markers: markers.map(({ location, size: markerSize }) => ({ location, size: markerSize })),
  });

  if (caption) {
    const visitors = data.totalVisitors || 0;
    const countries = data.totalCountries || markers.length;
    const since = data.since ? ` since ${data.since}` : '';
    caption.textContent =
      `${visitors.toLocaleString('en-US')} ${visitors === 1 ? 'visitor' : 'visitors'} ` +
      `from ${countries} ${countries === 1 ? 'country' : 'countries'}${since}`;
  }

  if (list) {
    list.textContent = markers
      .slice(0, 5)
      .map((m) => `${flagEmoji(m.country)} ${countryName(m.country)} ${m.visitors.toLocaleString('en-US')}`)
      .join('  ·  ');
  }

  animate(root, canvas, globe, () => size, (next) => { size = next; });
}

function animate(root, canvas, globe, getSize, setSize) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let phi = 0;
  let frame = null;
  let onScreen = true;

  // Pointer drag to spin, which is what people expect from a globe like this.
  let dragging = false;
  let dragStartX = 0;
  let phiAtDragStart = 0;

  const draw = () => {
    if (!dragging && !reduceMotion) phi += ROTATION_PER_FRAME;
    globe.update({ phi });
    frame = requestAnimationFrame(draw);
  };

  const start = () => {
    if (frame === null) frame = requestAnimationFrame(draw);
  };
  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };

  // A globe spinning in a background tab or below the fold is pure battery
  // drain, so only run the loop when it is actually visible.
  const sync = () => {
    if (onScreen && !document.hidden) start();
    else stop();
  };

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      sync();
    }, { threshold: 0 }).observe(root);
  }
  document.addEventListener('visibilitychange', sync);

  canvas.style.cursor = 'grab';
  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    dragStartX = event.clientX;
    phiAtDragStart = phi;
    canvas.style.cursor = 'grabbing';
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    phi = phiAtDragStart + (event.clientX - dragStartX) / 200;
  });
  const endDrag = () => {
    dragging = false;
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const next = measure(root);
      if (next === getSize()) return;
      setSize(next);
      canvas.style.width = `${next}px`;
      canvas.style.height = `${next}px`;
      globe.update({ width: next, height: next });
    }, 150);
  });

  // Render one frame immediately so the globe is visible even if the loop is
  // gated off (reduced motion, or scrolled out of view on load).
  globe.update({ phi });
  sync();
}
