// Rotating visitor globe for the homepage — the replacement for the RevolverMaps
// widget, which shut down in November 2024.
//
// Dots are cities, sized by session count. Data comes from
// data/visitor-globe.json, regenerated at deploy time by
// scripts/build-visitor-globe.mjs from Umami analytics. Nothing here tracks
// anyone: the page-view beacon is a separate script in index.html, and this file
// only reads an already-aggregated JSON file.
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
const LIST_LENGTH = 8;

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

let regionNames = null;
function countryName(code) {
  try {
    regionNames ||= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) || code;
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
  renderText(root, data);
  renderGlobe(root, markers, linkDashboard(root, data));
}

// Builds "🇩🇪 Germany 412" rows. Uses textContent throughout: city names arrive
// from an external API and must never be interpolated as markup.
function renderList(container, heading, rows) {
  if (!container) return;
  container.textContent = '';

  const title = document.createElement('div');
  title.textContent = heading;
  title.style.cssText = 'font-weight:700;margin-bottom:4px';
  container.appendChild(title);

  for (const row of rows.slice(0, LIST_LENGTH)) {
    const line = document.createElement('div');
    line.style.cssText = 'display:flex;justify-content:space-between;gap:10px;line-height:1.55';

    const label = document.createElement('span');
    label.textContent = `${flagEmoji(row.code)} ${row.label}`.trim();
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    const count = document.createElement('span');
    count.textContent = row.sessions.toLocaleString('en-US');
    count.style.cssText = 'color:#777;flex:none';

    line.append(label, count);
    container.appendChild(line);
  }
}

function renderText(root, data) {
  renderList(
    root.querySelector('[data-globe-countries]'),
    'Top countries',
    (data.countries || []).map((c) => ({ code: c.country, label: countryName(c.country), sessions: c.sessions })),
  );
  renderList(
    root.querySelector('[data-globe-cities]'),
    'Top cities',
    (data.cities || []).map((c) => ({ code: c.country, label: c.city, sessions: c.sessions })),
  );
}

// Points the globe at the public Umami dashboard. The URL is written into
// visitor-globe.json at build time rather than hardcoded here, so the share slug
// it contains stays out of the repo's history. https-only, because the value
// arrives from a build-time env var and this assigns it to an href.
function linkDashboard(root, data) {
  const link = root.querySelector('[data-globe-link]');
  const url = typeof data.shareUrl === 'string' ? data.shareUrl : '';
  if (!link || !url.startsWith('https://')) return null;

  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = 'Open the visitor dashboard';
  const canvas = link.querySelector('canvas');
  if (canvas) canvas.setAttribute('aria-label', `${canvas.getAttribute('aria-label')}. Opens the visitor dashboard.`);
  return link;
}

function renderGlobe(root, markers, link) {
  const canvas = root.querySelector('canvas');
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

  animate(root, canvas, globe, () => size, (next) => { size = next; }, link);
}

function animate(root, canvas, globe, getSize, setSize, link) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let phi = 0;
  let frame = null;
  let onScreen = true;

  // Pointer drag to spin, which is what people expect from a globe like this.
  let dragging = false;
  let dragStartX = 0;
  let phiAtDragStart = 0;
  // How far this pointer travelled, so a drag that ends on the globe is not also
  // treated as a click on the dashboard link wrapping it.
  let dragDistance = 0;
  const DRAG_SLOP = 4;

  const draw = () => {
    if (!dragging && !reduceMotion) phi += ROTATION_PER_FRAME;
    globe.update({ phi });
    frame = requestAnimationFrame(draw);
  };

  const start = () => { if (frame === null) frame = requestAnimationFrame(draw); };
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

  // 'pointer' when the globe is a link, so it reads as clickable; plain 'grab'
  // otherwise, when spinning it is all it does.
  const idleCursor = link ? 'pointer' : 'grab';
  canvas.style.cursor = idleCursor;
  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    dragStartX = event.clientX;
    phiAtDragStart = phi;
    dragDistance = 0;
    canvas.style.cursor = 'grabbing';
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    dragDistance = Math.max(dragDistance, Math.abs(event.clientX - dragStartX));
    phi = phiAtDragStart + (event.clientX - dragStartX) / 200;
  });
  const endDrag = () => {
    dragging = false;
    canvas.style.cursor = idleCursor;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // Spinning the globe should not navigate. Keyboard activation reports no
  // pointer movement, so it still follows the link.
  if (link) {
    link.addEventListener('click', (event) => {
      if (dragDistance > DRAG_SLOP) event.preventDefault();
      dragDistance = 0;
    });
    link.addEventListener('dragstart', (event) => event.preventDefault());
  }

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
