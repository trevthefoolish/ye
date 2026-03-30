const { books: BOOKS, chapters: CHAPTERS, rv: RENDER_VERSION } = JSON.parse(
  document.getElementById('config').textContent
);

const ALL = [];
CHAPTERS.forEach((n, bi) => { for (let c = 0; c < n; c++) ALL.push({ bi, ch: c }); });
const TOTAL = ALL.length;

// --- Constants ---
const PREFETCH_DISTANCE = 2;
const SCROLL_LRU_MAX = 50;
const SWIPE_DIR_THRESHOLD = 6;
const SWIPE_COMMIT_SLOW = 0.15;
const SWIPE_COMMIT_RANGE = 0.07;
const SKELETON_WIDTHS = [100, 85, 92, 78, 95, 60];
const TRACK_CENTER = 'translateX(-33.333%)';
const SPRING_DURATION = 0.4;
const SPRING_EASING = 'cubic-bezier(0.25,0.46,0.45,0.94)';
const SLIDE_DUR_MIN = 0.12;
const SLIDE_DUR_MAX = 0.35;

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
      if (!res.ok) throw new Error('fetch failed');
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
    const idle = window.requestIdleCallback || (cb => setTimeout(cb, 100));
    idle(() => fetchChapter(BOOKS[e.bi], e.ch + 1).catch(() => {}));
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
  } catch {}
  return ALL.findIndex(a => a.bi === 20 && a.ch === 0);
}

let pos = posFromPath();
let sliding = false;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
}

// Scroll-linked header shadow
function bindScrollShadow() {
  const scrollEl = panels[1].querySelector('.chapter-scroll');
  if (!scrollEl) return;
  header.classList.toggle('scrolled', scrollEl.scrollTop > 0);
  scrollEl.addEventListener('scroll', () => {
    header.classList.toggle('scrolled', scrollEl.scrollTop > 0);
  }, { passive: true });
}

// --- NAV ---
var navOpen = false;
function closeNav() {
  navOpen = false;
  nav.style.display = 'none';
}

header.addEventListener('click', () => {
  if (sliding) return;
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
      pill.addEventListener('click', ev => {
        ev.stopPropagation();
        closeNav();
        if (b === curBi && c === curCh + 1) return;
        const np = ALL.findIndex(a => a.bi === b && a.ch === c - 1);
        if (np >= 0) { pos = np; navJump(); }
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
      if (prev && prev !== item) prev.classList.remove('expanded');
      item.classList.toggle('expanded', !wasExpanded);
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
  nav.style.display = 'block';
  if (currentItem) currentItem.scrollIntoView({ block: 'center' });
});

nav.addEventListener('click', closeNav);

// --- RENDER ---
function renderVersesInto(scroll, verses) {
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
    scroll.appendChild(wrap);
  }
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  scroll.appendChild(spacer);
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
      scroll.offsetWidth;
      scroll.style.transition = 'opacity 0.2s ease-out';
      scroll.style.opacity = '1';
      scroll.addEventListener('transitionend', () => {
        scroll.style.transition = '';
      }, { once: true });
    }
  } catch {
    if (stale()) return;
    scroll.replaceChildren();
    const msg = document.createElement('div');
    msg.className = 'empty-msg';
    msg.textContent = 'Could not load this chapter. Try again shortly.';
    scroll.appendChild(msg);
  }
}

function saveCurrentScroll() {
  const scroll = panels[1].querySelector('.chapter-scroll');
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
  saveCurrentScroll();
  if (reduceMotion) { fillAllPanels(); return; }
  reading.style.transition = 'opacity 0.15s ease-out';
  reading.style.opacity = '0';
  setTimeout(() => {
    fillAllPanels();
    reading.style.transition = 'opacity 0.2s ease-out';
    reading.style.opacity = '1';
  }, 150);
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
  track.offsetWidth; // force reflow
}

function springBack() {
  track.style.transition = 'transform ' + SPRING_DURATION + 's ' + SPRING_EASING;
  track.style.transform = TRACK_CENTER;
  setPanelTransitions(SPRING_DURATION);
  clearPanelEffects();
}

function atBoundary(p, dx) {
  return (p === 0 && dx > 0) || (p === TOTAL - 1 && dx < 0);
}

// --- GPU EFFECTS ---

function applyPanelEffects(progress) {
  if (reduceMotion) return;
  const abs = Math.min(Math.abs(progress), 1);
  const dir = progress < 0 ? 1 : -1; // 1 = forward, -1 = back
  const inIdx = dir === 1 ? 2 : 0;
  const outIdx = dir === 1 ? 0 : 2;

  // Incoming: scale 0.92→1, opacity 0.6→1
  panels[inIdx].style.transform = 'translateZ(0) scale(' + (0.92 + abs * 0.08) + ')';
  panels[inIdx].style.opacity = 0.6 + abs * 0.4;

  // Outgoing: scale 1→0.96, dim
  panels[outIdx].style.transform = 'translateZ(0) scale(' + (1 - abs * 0.04) + ')';
  panels[outIdx].style.filter = 'brightness(' + (1 - abs * 0.15) + ')';

  // Current: directional shadow
  const shadowX = progress * 8;
  panels[1].style.boxShadow = abs > 0.02
    ? shadowX + 'px 0 ' + (16 * abs) + 'px rgba(0,0,0,' + (0.12 * abs) + ')'
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
  if (reduceMotion) return;
  const t = 'transform ' + dur + 's ease-out, opacity ' + dur + 's ease-out, filter ' + dur + 's ease-out, box-shadow ' + dur + 's ease-out';
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
  const dur = Math.max(SLIDE_DUR_MIN, Math.min(SLIDE_DUR_MAX, 0.3 / (1 + vel * 2)));

  // Velocity-dependent spring curves
  let ease = 'cubic-bezier(0.16,1,0.3,1)';
  if (!reduceMotion) {
    if (vel > 0.6) ease = 'cubic-bezier(0.22,1.15,0.36,1)';
    else if (vel > 0.2) ease = 'cubic-bezier(0.175,0.885,0.32,1.05)';
  }

  track.style.transition = 'transform ' + dur + 's ' + ease;
  track.style.transform = 'translateX(' + (dir === 1 ? '-66.666%' : '0%') + ')';

  // Drive panel effects to final state
  setPanelTransitions(dur);
  if (!reduceMotion) {
    const inIdx = dir === 1 ? 2 : 0;
    const outIdx = dir === 1 ? 0 : 2;
    panels[inIdx].style.transform = 'translateZ(0) scale(1)';
    panels[inIdx].style.opacity = '1';
    panels[outIdx].style.transform = 'translateZ(0) scale(0.96)';
    panels[outIdx].style.filter = 'brightness(0.85)';
    panels[1].style.boxShadow = 'none';
  }

  function onDone() {
    clearTimeout(safety);
    track.removeEventListener('transitionend', onDone);

    // Save scroll position of outgoing panel
    const outPanel = panels[dir === 1 ? 0 : 2];
    const outScroll = outPanel.querySelector('.chapter-scroll');
    if (outScroll) {
      const outP = parseInt(outScroll.dataset.p);
      if (!isNaN(outP)) {
        scrollPositions.set(outP, outScroll.scrollTop);
        if (scrollPositions.size > SCROLL_LRU_MAX) scrollPositions.delete(scrollPositions.keys().next().value);
      }
    }

    pos = np;
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
  }

  track.addEventListener('transitionend', onDone, { once: true });
  const safety = setTimeout(onDone, dur * 1000 + 100);
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
  if (touch.horiz === null && (Math.abs(mx) > SWIPE_DIR_THRESHOLD || Math.abs(my) > SWIPE_DIR_THRESHOLD)) {
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
    visualDx = sign * Math.sqrt(Math.abs(touch.dx)) * 3;
  }
  const pct = -33.333 + visualDx / touch.width * 33.333;
  track.style.transform = 'translateX(' + pct + '%)';

  // Per-panel depth effects (skip at boundaries)
  if (!bounded) {
    applyPanelEffects(visualDx / touch.width);
  }
  // Edge glow at boundaries
  const glowAmt = Math.min(0.2, Math.abs(visualDx) / 200);
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
    track.style.transition = 'transform ' + SPRING_DURATION + 's ' + SPRING_EASING;
    track.style.transform = TRACK_CENTER;
    return;
  }

  // Velocity-adaptive threshold
  const elapsed = Date.now() - touch.startTime || 1;
  const velocity = Math.abs(touch.dx) / elapsed; // px/ms
  const distRatio = Math.abs(touch.dx) / touch.width;
  const velT = Math.max(0, Math.min(1, (velocity - 0.1) / 0.4));
  const threshold = SWIPE_COMMIT_SLOW - velT * SWIPE_COMMIT_RANGE;

  if (distRatio > threshold) {
    slideTo(touch.dx < 0 ? 1 : -1, velocity);
  } else {
    // Snap back — duration proportional to how far we dragged
    const snapDur = Math.max(0.15, Math.min(0.3, distRatio * 2));
    const snapEase = reduceMotion ? 'cubic-bezier(0.16,1,0.3,1)' : 'cubic-bezier(0.25,1.1,0.35,1)';
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
} catch {}

fillAllPanels();
history.replaceState({ pos }, '', '/' + toSlug(BOOKS[ALL[pos].bi]) + '/' + (ALL[pos].ch + 1));

// Prefetch chapters 2 steps ahead/behind on idle
(window.requestIdleCallback || (cb => setTimeout(cb, 200)))(() => {
  prefetchAdjacent(pos, 1);
  prefetchAdjacent(pos, -1);
});
