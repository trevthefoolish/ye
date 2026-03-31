/*! Copyright (c) 2026 vapourware.ai All rights reserved. */
const { books: BOOKS, chapters: CHAPTERS, rv: RENDER_VERSION } = JSON.parse(
  document.getElementById('config').textContent
);

// --- Symmetry engine: read all design tokens once at startup ---
const SYM = (() => {
  const s = getComputedStyle(document.documentElement);
  const v = n => s.getPropertyValue(n).trim();
  const f = n => parseFloat(v(n));
  return Object.freeze({
    durInstant: f('--dur-instant'), durBlink: f('--dur-blink'),
    durBreath: f('--dur-breath'), durSettle: f('--dur-settle'),
    delayStagger: f('--delay-stagger'),
    slideDurMin: f('--slide-dur-min'), slideDurMax: f('--slide-dur-max'),
    springDur: f('--spring-dur'), safetyPad: f('--safety-pad'),
    navFadeOut: f('--nav-fade-out'), navFadeIn: f('--nav-fade-in'),
    easeOut: v('--ease-out'), easeSpring: v('--ease-spring'), easeSlide: v('--ease-slide'),
    easeFlick: v('--ease-flick'), easeToss: v('--ease-toss'),
    easeSnap: v('--ease-snap'),
    depthInScale: f('--depth-in-scale'), depthOutScale: f('--depth-out-scale'),
    depthOutDim: f('--depth-out-dim'), depthShadowX: f('--depth-shadow-x'),
    depthShadowBlur: f('--depth-shadow-blur'),
    depthShadowOpacity: f('--depth-shadow-opacity'),
    depthShadowMin: f('--depth-shadow-min'),
    swipeDirThreshold: f('--swipe-dir-threshold'),
    swipeCommitSlow: f('--swipe-commit-slow'),
    swipeCommitRange: f('--swipe-commit-range'),
    rubberBandFactor: f('--rubber-band-factor'),
    edgeGlowMax: f('--edge-glow-max'), edgeGlowDivisor: f('--edge-glow-divisor'),
    velSlow: f('--vel-slow'), velFast: f('--vel-fast'),
    velFlick: f('--vel-flick'), velToss: f('--vel-toss'),
    velDurBase: f('--vel-dur-base'), velDurScale: f('--vel-dur-scale'),
    opacitySmoke: f('--opacity-smoke'),
  });
})();

// --- Analytics & error reporting ---
let viewCount = 0;
function beacon(url, payload) {
  try {
    const body = JSON.stringify(payload);
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon) navigator.sendBeacon(url, blob);
    else fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
  } catch {}
}
function ev(type, data) { beacon('/api/ev', { type, ...data }); }
function reportError(type, msg) { beacon('/api/log', { type, msg: String(msg).slice(0, 500), url: location.pathname }); }
window.onerror = (msg, src, line, col) => { reportError('onerror', msg + ' at ' + src + ':' + line + ':' + col); };
window.addEventListener('unhandledrejection', e => { reportError('unhandled', e.reason?.message || String(e.reason)); });

const ALL = [];
CHAPTERS.forEach((n, bi) => { for (let c = 0; c < n; c++) ALL.push({ bi, ch: c }); });
const TOTAL = ALL.length;

// --- Constants ---
const PREFETCH_DISTANCE = 2;
const SCROLL_LRU_MAX = 50;
const SKELETON_WIDTHS = [100, 85, 92, 78, 95, 60];
const TRACK_CENTER = 'translateX(-33.333%)';

// Transition helper: fire fn on transitionend (filtered by prop) or safety timeout
function onTransition(el, prop, timeoutMs, fn) {
  function handler(e) {
    if (e && prop && e.propertyName !== prop) return;
    el.removeEventListener('transitionend', handler);
    clearTimeout(safety);
    fn();
  }
  el.addEventListener('transitionend', handler);
  const safety = setTimeout(() => {
    el.removeEventListener('transitionend', handler);
    fn();
  }, timeoutMs);
}

function toSlug(name) { return name.replace(/ /g, '-'); }
function fromSlug(slug) { return slug.replace(/-/g, ' '); }

const BOOKS_LOWER = BOOKS.map(b => b.toLowerCase());

// --- Client-side chapter cache + request deduplication ---
const chapterCache = new Map();
const inflightFetches = new Map();
const scrollPositions = new Map();

function fetchChapter(bookName, chNum) {
  const key = `${bookName}/${chNum}`;
  if (chapterCache.has(key)) return Promise.resolve(chapterCache.get(key));
  if (inflightFetches.has(key)) return inflightFetches.get(key);
  const promise = fetch(`/api/chapter/${encodeURIComponent(bookName)}/${chNum}?v=${RENDER_VERSION}`)
    .then(res => {
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      return res.json();
    })
    .then(data => {
      if (data.verses?.length) chapterCache.set(key, data);
      inflightFetches.delete(key);
      return data;
    })
    .catch(err => {
      inflightFetches.delete(key);
      throw err;
    });
  inflightFetches.set(key, promise);
  return promise;
}

function prefetchAdjacent(p, dir) {
  const ahead = p + (dir || 1) * PREFETCH_DISTANCE;
  if (ahead >= 0 && ahead < TOTAL) {
    const e = ALL[ahead];
    const idle = window.requestIdleCallback || (cb => setTimeout(cb, SYM.durInstant * 1000));
    idle(() => fetchChapter(BOOKS[e.bi], e.ch + 1).catch(err => reportError('prefetch', err.message)));
  }
}

function posFromPath() {
  try {
    const parts = decodeURIComponent(window.location.pathname).split('/').filter(Boolean);
    if (parts.length === 2) {
      const bookName = fromSlug(parts[0]);
      const ch = parseInt(parts[1]);
      const bi = BOOKS_LOWER.indexOf(bookName.toLowerCase());
      if (bi !== -1 && ch >= 1 && ch <= CHAPTERS[bi]) {
        const idx = ALL.findIndex(a => a.bi === bi && a.ch === ch - 1);
        if (idx >= 0) return idx;
      }
    }
  } catch (e) { reportError('url_parse', e.message); }
  return ALL.findIndex(a => a.bi === 20 && a.ch === 0); // default: Ecclesiastes 1
}

let pos = posFromPath();
let sliding = false;

const track = document.getElementById('swipe-track');
const container = document.getElementById('swipe-container');
const header = document.getElementById('header');
const nav = document.getElementById('nav');
const bookList = document.getElementById('book-list');
// panels[0]=prev, panels[1]=current, panels[2]=next — rotated in place
const panels = Array.from(track.children);

function chapterLabel(p) { const e = ALL[p]; return BOOKS[e.bi] + ' ' + (e.ch + 1); }
function updateHeader() {
  const e = ALL[pos];
  const text = chapterLabel(pos);
  document.title = text;
  const url = '/' + toSlug(BOOKS[e.bi]) + '/' + (e.ch + 1);
  if (window.location.pathname !== url) {
    history.pushState({ pos }, '', url);
  }
  header.textContent = text;
  viewCount++;
  ev('view', { book: BOOKS[e.bi], ch: e.ch + 1 });
}

// Scroll-linked header shadow
let scrollAC;
function bindScrollShadow() {
  if (scrollAC) scrollAC.abort();
  scrollAC = new AbortController();
  const scrollEl = panels[1].querySelector('.chapter-scroll');
  if (!scrollEl) return;
  header.classList.toggle('scrolled', scrollEl.scrollTop > 0);
  scrollEl.addEventListener('scroll', () => {
    header.classList.toggle('scrolled', scrollEl.scrollTop > 0);
  }, { passive: true, signal: scrollAC.signal });
}

// --- NAV ---
let navOpen = false;
function fadeNavOut(onComplete) {
  nav.classList.remove('open');
  nav.classList.add('curtain');
  onTransition(bookList, 'opacity', (SYM.durBreath + SYM.delayStagger) * 1000 + SYM.safetyPad, () => {
    if (!navOpen) nav.classList.remove('curtain');
    if (onComplete) onComplete();
  });
}
function closeNav() {
  if (!navOpen) return;
  navOpen = false;
  fadeNavOut();
}

header.addEventListener('click', () => {
  if (sliding || navOpen) return;
  const curBi = ALL[pos].bi;
  const curCh = ALL[pos].ch;
  bookList.replaceChildren();
  for (let b = 0; b < BOOKS.length; b++) {
    const item = document.createElement('div');
    item.className = 'book-item' + (b === curBi ? ' current' : '');
    const name = document.createElement('span');
    name.className = 'book-name';
    name.textContent = BOOKS[b];
    item.appendChild(name);

    // Build chapter grid (always present, animated via .expanded)
    const wrap = document.createElement('div');
    wrap.className = 'chapter-grid-wrap';
    const grid = document.createElement('div');
    grid.className = 'chapter-grid';
    for (let c = 1; c <= CHAPTERS[b]; c++) {
      const pill = document.createElement('span');
      pill.className = 'chapter-pill' + (b === curBi && c === curCh + 1 ? ' current' : '');
      pill.textContent = c;
      pill.addEventListener('click', e => {
        e.stopPropagation();
        if (b === curBi && c === curCh + 1) { closeNav(); return; }
        const np = ALL.findIndex(a => a.bi === b && a.ch === c - 1);
        if (np < 0) return;
        navOpen = false;
        fadeNavOut(() => {
          pos = np; ev('nav', { method: 'tap' }); saveScroll(); fillAllPanels();
          requestAnimationFrame(() => { nav.classList.remove('curtain'); });
        });
      });
      grid.appendChild(pill);
    }
    grid.addEventListener('click', e => e.stopPropagation());
    wrap.appendChild(grid);
    item.appendChild(wrap);

    name.addEventListener('click', e => {
      e.stopPropagation();
      const wasExpanded = item.classList.contains('expanded');
      // Collapse any other expanded book
      const prev = bookList.querySelector('.book-item.expanded');
      if (prev && prev !== item) { prev.classList.remove('expanded'); }
      item.classList.toggle('expanded', !wasExpanded);
      // Scroll newly expanded book into view after grid animation
      if (!wasExpanded) {
        onTransition(wrap, 'grid-template-rows', SYM.durSettle * 1000 + SYM.safetyPad, () => {
          item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }
    });
    bookList.appendChild(item);
  }
  // Auto-expand current book
  const currentItem = bookList.querySelector('.current');
  if (currentItem) {
    currentItem.classList.add('expanded');
  }
  navOpen = true;
  history.pushState({ nav: true, pos }, '');
  nav.scrollTop = 0;
  nav.classList.remove('curtain');
  nav.classList.add('open');
  if (currentItem) currentItem.scrollIntoView({ block: 'center' });
});

nav.addEventListener('click', closeNav);

// --- RENDER ---
function renderVersesInto(scroll, verses) {
  const frag = document.createDocumentFragment();
  for (const v of verses) {
    if (!v) continue;
    const wrap = document.createElement('div');
    wrap.className = 'verse-wrap';
    const vText = document.createElement('div');
    vText.textContent = v.rendering;
    wrap.appendChild(vText);
    const nEl = document.createElement('div');
    nEl.className = 'note';
    const nInner = document.createElement('div');
    nInner.className = 'note-inner';
    nInner.textContent = v.note;
    nEl.appendChild(nInner);
    wrap.appendChild(nEl);
    wrap.addEventListener('click', () => {
      if (sliding || touch.horiz) return;
      wrap.classList.toggle('expanded');
    });
    frag.appendChild(wrap);
  }
  const copy = document.createElement('p');
  copy.className = 'copyright';
  copy.textContent = '\u00A9 2026 vapourware.ai';
  copy.appendChild(document.createElement('br'));
  copy.appendChild(document.createTextNode('All rights reserved.'));
  frag.appendChild(copy);
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  frag.appendChild(spacer);
  scroll.appendChild(frag);
}

// Fill a single panel with chapter content
async function fillPanel(panel, p) {
  const scroll = document.createElement('div');
  scroll.className = 'chapter-scroll';
  scroll.dataset.p = p;
  panel.replaceChildren();
  panel.appendChild(scroll);
  if (p === null || p < 0 || p >= TOTAL) return;

  const stale = () => !scroll.isConnected || scroll.dataset.p !== String(p);
  const e = ALL[p];
  const bookName = BOOKS[e.bi];
  const chNum = e.ch + 1;

  // Show skeleton while loading (only for non-cached content)
  const key = `${bookName}/${chNum}`;
  const willFade = !chapterCache.has(key);
  if (willFade) {
    for (let i = 0; i < SKELETON_WIDTHS.length; i++) {
      const line = document.createElement('div');
      line.className = 'skeleton-line';
      line.style.width = SKELETON_WIDTHS[i] + '%';
      scroll.appendChild(line);
    }
  }

  try {
    const data = await fetchChapter(bookName, chNum);
    if (stale()) return;
    const { verses } = data;
    if (stale()) return;
    if (!verses || verses.length === 0) {
      scroll.replaceChildren();
      const msg = document.createElement('div');
      msg.className = 'empty-msg';
      msg.textContent = 'This chapter is still being rendered. Try again shortly.';
      scroll.appendChild(msg);
      return;
    }
    scroll.replaceChildren();
    renderVersesInto(scroll, verses);
    // Restore saved scroll position
    const savedScroll = scrollPositions.get(p);
    if (savedScroll) scroll.scrollTop = savedScroll;
    // Fade in content that was behind a skeleton
    if (willFade) {
      scroll.style.opacity = '0';
      scroll.offsetWidth; // force reflow so transition plays from opacity:0
      scroll.style.transition = 'opacity ' + SYM.durBreath + 's ' + SYM.easeOut;
      scroll.style.opacity = '1';
      scroll.addEventListener('transitionend', () => {
        scroll.style.transition = '';
      }, { once: true });
    }
  } catch (err) {
    if (stale()) return;
    reportError('chapter_load', bookName + ' ' + chNum + ': ' + err.message);
    scroll.replaceChildren();
    const msg = document.createElement('div');
    msg.className = 'empty-msg';
    msg.textContent = 'Could not load this chapter. Try again shortly.';
    scroll.appendChild(msg);
  }
}

function saveScroll(panel) {
  const scroll = (panel || panels[1]).querySelector('.chapter-scroll');
  if (scroll && scroll.dataset.p != null) {
    const p = parseInt(scroll.dataset.p);
    if (!isNaN(p)) {
      scrollPositions.set(p, scroll.scrollTop);
      if (scrollPositions.size > SCROLL_LRU_MAX) scrollPositions.delete(scrollPositions.keys().next().value);
    }
  }
}

const reading = document.getElementById('reading');
function navJump() {
  saveScroll();
  reading.style.transition = 'opacity ' + SYM.navFadeOut + 's ' + SYM.easeOut;
  reading.style.opacity = '0';
  setTimeout(() => {
    fillAllPanels();
    reading.style.transition = 'opacity ' + SYM.navFadeIn + 's ' + SYM.easeOut;
    reading.style.opacity = '1';
  }, SYM.navFadeOut * 1000);
}

// Fill all 3 panels from scratch (used for init + nav jumps)
function fillAllPanels() {
  fillPanel(panels[0], pos > 0 ? pos - 1 : null);
  fillPanel(panels[1], pos);
  fillPanel(panels[2], pos < TOTAL - 1 ? pos + 1 : null);
  resetTrack();
  updateHeader();
  header.classList.remove('scrolled');
  bindScrollShadow();
}

// Reset track to center position with no transition
function resetTrack() {
  track.style.transition = 'none';
  track.style.transform = TRACK_CENTER;
  track.offsetWidth; // force reflow so 'transition:none' is flushed before next frame
}

function springBack() {
  track.style.transition = 'transform ' + SYM.springDur + 's ' + SYM.easeSpring;
  track.style.transform = TRACK_CENTER;
  setPanelTransitions(SYM.springDur);
  clearPanelEffects();
}

function atBoundary(p, dx) {
  return (p === 0 && dx > 0) || (p === TOTAL - 1 && dx < 0);
}

// --- GPU EFFECTS ---

function applyPanelEffects(progress) {
  const abs = Math.min(Math.abs(progress), 1);
  const dir = progress < 0 ? 1 : -1; // 1 = forward, -1 = back
  const inIdx = dir === 1 ? 2 : 0;
  const outIdx = dir === 1 ? 0 : 2;

  // Incoming: scale depthInScale→1, opacity smoke→1
  panels[inIdx].style.transform = 'translateZ(0) scale(' + (SYM.depthInScale + abs * (1 - SYM.depthInScale)) + ')';
  panels[inIdx].style.opacity = SYM.opacitySmoke + abs * (1 - SYM.opacitySmoke);

  // Outgoing: scale 1→depthOutScale, dim to depthOutDim
  panels[outIdx].style.transform = 'translateZ(0) scale(' + (1 - abs * (1 - SYM.depthOutScale)) + ')';
  panels[outIdx].style.filter = 'brightness(' + (1 - abs * (1 - SYM.depthOutDim)) + ')';

  // Current: directional shadow
  const shadowX = progress * SYM.depthShadowX;
  panels[1].style.boxShadow = abs > SYM.depthShadowMin
    ? shadowX + 'px 0 ' + (SYM.depthShadowBlur * abs) + 'px rgba(0,0,0,' + (SYM.depthShadowOpacity * abs) + ')'
    : 'none';
}

function clearPanelEffects() {
  for (let i = 0; i < 3; i++) {
    panels[i].style.transform = 'translateZ(0)';
    panels[i].style.opacity = '';
    panels[i].style.filter = '';
    panels[i].style.boxShadow = '';
    panels[i].style.transition = '';
  }
}

function setPanelTransitions(dur) {
  const t = 'transform ' + dur + 's ' + SYM.easeOut + ', opacity ' + dur + 's ' + SYM.easeOut + ', filter ' + dur + 's ' + SYM.easeOut + ', box-shadow ' + dur + 's ' + SYM.easeOut;
  for (let i = 0; i < 3; i++) panels[i].style.transition = t;
}

// --- SWIPE ---
function slideTo(dir, velocity) {
  if (sliding) return;
  const np = pos + dir;
  if (np < 0 || np >= TOTAL) { springBack(); return; }
  sliding = true;

  // Scale duration with velocity: fast flick ~150ms, slow drag ~300ms
  const vel = velocity || 0;
  const dur = Math.max(SYM.slideDurMin, Math.min(SYM.slideDurMax, SYM.velDurBase / (1 + vel * SYM.velDurScale)));

  // Velocity-dependent spring curves
  let ease = SYM.easeSlide;
  if (vel > SYM.velFlick) ease = SYM.easeFlick;
  else if (vel > SYM.velToss) ease = SYM.easeToss;

  track.style.transition = 'transform ' + dur + 's ' + ease;
  track.style.transform = 'translateX(' + (dir === 1 ? '-66.666%' : '0%') + ')';

  // Drive panel effects to final state
  setPanelTransitions(dur);
  const inIdx = dir === 1 ? 2 : 0;
  const outIdx = dir === 1 ? 0 : 2;
  panels[inIdx].style.transform = 'translateZ(0) scale(1)';
  panels[inIdx].style.opacity = '1';
  panels[outIdx].style.transform = 'translateZ(0) scale(' + SYM.depthOutScale + ')';
  panels[outIdx].style.filter = 'brightness(' + SYM.depthOutDim + ')';
  panels[1].style.boxShadow = 'none';

  onTransition(track, null, dur * 1000 + SYM.safetyPad, () => {
    saveScroll(panels[dir === 1 ? 0 : 2]);

    pos = np;
    ev('nav', { method: 'swipe' });
    updateHeader();

    if (dir === 1) {
      track.appendChild(panels[0]);
      panels.push(panels.shift());
    } else {
      track.insertBefore(panels[2], panels[0]);
      panels.unshift(panels.pop());
    }

    clearPanelEffects();
    resetTrack();
    bindScrollShadow();

    if (dir === 1) {
      fillPanel(panels[2], pos < TOTAL - 1 ? pos + 1 : null);
    } else {
      fillPanel(panels[0], pos > 0 ? pos - 1 : null);
    }

    sliding = false;

    // Prefetch the chapter beyond the new adjacent (warm cache for next swipe)
    prefetchAdjacent(pos, dir);
  });
}

// --- TOUCH HANDLING ---
const touch = { sx: 0, sy: 0, dx: 0, drag: false, horiz: null, startTime: 0, width: 0, rafId: null };
const edgeL = document.getElementById('edge-glow-left');
const edgeR = document.getElementById('edge-glow-right');

container.addEventListener('touchstart', e => {
  if (sliding) return;
  touch.sx = e.touches[0].clientX;
  touch.sy = e.touches[0].clientY;
  touch.dx = 0; touch.drag = true; touch.horiz = null;
  touch.startTime = Date.now();
  touch.width = container.offsetWidth;
  track.style.transition = 'none';
  clearPanelEffects();
}, { passive: true });

container.addEventListener('touchmove', e => {
  if (!touch.drag || sliding) return;
  const mx = e.touches[0].clientX - touch.sx;
  const my = e.touches[0].clientY - touch.sy;
  if (touch.horiz === null && (Math.abs(mx) > SYM.swipeDirThreshold || Math.abs(my) > SYM.swipeDirThreshold)) {
    touch.horiz = Math.abs(mx) > Math.abs(my);
  }
  if (touch.horiz === false) { touch.drag = false; return; }
  if (touch.horiz) {
    e.preventDefault();
    touch.dx = mx;
    if (!touch.rafId) touch.rafId = requestAnimationFrame(applyDrag);
  }
}, { passive: false });

function applyDrag() {
  touch.rafId = null;
  // Rubber-band at boundaries: diminishing returns via sqrt
  let visualDx = touch.dx;
  const bounded = atBoundary(pos, touch.dx);
  if (bounded) {
    const sign = touch.dx > 0 ? 1 : -1;
    visualDx = sign * Math.sqrt(Math.abs(touch.dx)) * SYM.rubberBandFactor;
  }
  const pct = -33.333 + visualDx / touch.width * 33.333;
  track.style.transform = 'translateX(' + pct + '%)';

  // Per-panel depth effects (skip at boundaries)
  if (!bounded) {
    applyPanelEffects(visualDx / touch.width);
  }
  // Edge glow at boundaries
  const glowAmt = Math.min(SYM.edgeGlowMax, Math.abs(visualDx) / SYM.edgeGlowDivisor);
  if (pos === 0 && touch.dx > 0) edgeL.style.opacity = glowAmt;
  if (pos === TOTAL - 1 && touch.dx < 0) edgeR.style.opacity = glowAmt;
}

container.addEventListener('touchcancel', () => {
  if (!touch.drag) return;
  touch.drag = false;
  if (touch.rafId) { cancelAnimationFrame(touch.rafId); touch.rafId = null; }
  edgeL.style.opacity = '0';
  edgeR.style.opacity = '0';
  springBack();
});

container.addEventListener('touchend', () => {
  if (!touch.drag || !touch.horiz) { touch.drag = false; return; }
  touch.drag = false;
  if (touch.rafId) { cancelAnimationFrame(touch.rafId); touch.rafId = null; }

  // Clear edge glows
  edgeL.style.opacity = '0';
  edgeR.style.opacity = '0';

  // Boundary: just spring back
  if (atBoundary(pos, touch.dx)) {
    track.style.transition = 'transform ' + SYM.springDur + 's ' + SYM.easeSpring;
    track.style.transform = TRACK_CENTER;
    return;
  }

  // Velocity-adaptive threshold
  const elapsed = Date.now() - touch.startTime || 1;
  const velocity = Math.abs(touch.dx) / elapsed; // px/ms
  const distRatio = Math.abs(touch.dx) / touch.width;
  const velT = Math.max(0, Math.min(1, (velocity - SYM.velSlow) / SYM.velFast));
  const threshold = SYM.swipeCommitSlow - velT * SYM.swipeCommitRange;

  if (distRatio > threshold) {
    slideTo(touch.dx < 0 ? 1 : -1, velocity);
  } else {
    // Snap back — duration proportional to how far we dragged
    const snapDur = Math.max(SYM.durBlink, Math.min(SYM.durSettle, distRatio * 2));
    const snapEase = SYM.easeSnap;
    track.style.transition = 'transform ' + snapDur + 's ' + snapEase;
    track.style.transform = TRACK_CENTER;
    setPanelTransitions(snapDur);
    clearPanelEffects();
  }
});

// --- POPSTATE (back/forward) ---
window.addEventListener('popstate', (e) => {
  // If nav overlay is open, back button closes it
  if (navOpen) { closeNav(); return; }
  if (sliding) return;
  const newPos = e.state?.pos ?? posFromPath();
  if (newPos !== pos && newPos >= 0 && newPos < TOTAL) {
    pos = newPos;
    navJump();
  }
});

// --- INIT ---
// Seed cache from server-inlined chapter data (eliminates initial fetch round-trip)
try {
  const pre = document.getElementById('preloaded');
  if (pre) {
    const d = JSON.parse(pre.textContent);
    if (d.book && d.ch && d.verses?.length) {
      chapterCache.set(d.book + '/' + d.ch, { verses: d.verses });
    }
  }
} catch (e) { reportError('preload_parse', e.message); }

fillAllPanels();
history.replaceState({ pos }, '', '/' + toSlug(BOOKS[ALL[pos].bi]) + '/' + (ALL[pos].ch + 1));

// Prefetch chapters 2 steps ahead/behind on idle
(window.requestIdleCallback || (cb => setTimeout(cb, SYM.durBreath * 1000)))(() => {
  prefetchAdjacent(pos, 1);
  prefetchAdjacent(pos, -1);
});

// Session depth: report how many chapters read when leaving
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && viewCount > 0) {
    ev('session', { depth: viewCount });
  }
});

// Performance metrics after first paint
requestAnimationFrame(() => {
  setTimeout(() => {
    const navEntry = performance.getEntriesByType('navigation')[0];
    if (navEntry) {
      ev('perf', { loadMs: navEntry.loadEventEnd - navEntry.startTime, ttiMs: navEntry.domInteractive - navEntry.startTime });
    }
  }, 0);
});
