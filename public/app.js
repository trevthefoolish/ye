const { books: BOOKS, chapters: CHAPTERS, rv: RENDER_VERSION } = JSON.parse(
  document.getElementById('config').textContent
);

const ALL = [];
CHAPTERS.forEach((n, bi) => { for (let c = 0; c < n; c++) ALL.push({ bi, ch: c }); });
const TOTAL = ALL.length;

function toSlug(name) { return name.replace(/ /g, '-'); }
function fromSlug(slug) { return slug.replace(/-/g, ' '); }

const BOOKS_LOWER = BOOKS.map(b => b.toLowerCase());

// --- Client-side chapter cache + request deduplication ---
const chapterCache = new Map();
const inflightFetches = new Map();

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

function lbl(p) { const e = ALL[p]; return BOOKS[e.bi] + ' ' + (e.ch + 1); }
function updateHeader() {
  const e = ALL[pos];
  const text = lbl(pos);
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
function closeNav() { nav.classList.remove('open'); }

function collapseGrid(wrap, instant) {
  if (!wrap) return;
  if (instant) { wrap.remove(); return; }
  wrap.classList.remove('expanded');
  const safety = setTimeout(() => { if (wrap.isConnected) wrap.remove(); }, 350);
  wrap.addEventListener('transitionend', () => { clearTimeout(safety); wrap.remove(); }, { once: true });
}

function buildChapterGrid(item, b) {
  const curBi = ALL[pos].bi;
  const curCh = ALL[pos].ch;
  const wrap = document.createElement('div');
  wrap.className = 'chapter-grid-wrap';
  const grid = document.createElement('div');
  grid.className = 'chapter-grid';
  for (let c = 1; c <= CHAPTERS[b]; c++) {
    const pill = document.createElement('span');
    pill.className = 'chapter-pill' + (b === curBi && c === curCh + 1 ? ' current' : '');
    pill.textContent = c;
    pill.addEventListener('click', () => {
      closeNav();
      const liveBi = ALL[pos].bi;
      const liveCh = ALL[pos].ch;
      if (b === liveBi && c === liveCh + 1) return; // already here
      const np = ALL.findIndex(a => a.bi === b && a.ch === c - 1);
      if (np >= 0) { pos = np; fillAllPanels(); }
    });
    grid.appendChild(pill);
  }
  wrap.appendChild(grid);
  wrap.addEventListener('click', e => e.stopPropagation());
  item.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('expanded'));
}

let bookListBuilt = false;

header.addEventListener('click', () => {
  if (sliding) return;
  const curBi = ALL[pos].bi;

  if (!bookListBuilt) {
    // Build once
    for (let b = 0; b < 66; b++) {
      const item = document.createElement('div');
      item.className = 'book-item';
      item.dataset.book = b;
      const name = document.createElement('span');
      name.className = 'book-name';
      name.textContent = BOOKS[b];
      item.appendChild(name);
      name.addEventListener('click', e => {
        e.stopPropagation();
        const bi = b;
        const liveBi = ALL[pos].bi;
        // Single-chapter books: navigate or close
        if (CHAPTERS[bi] === 1) {
          if (bi === liveBi) { closeNav(); return; }
          closeNav();
          const np = ALL.findIndex(a => a.bi === bi && a.ch === 0);
          if (np >= 0) { pos = np; fillAllPanels(); }
          return;
        }
        // Multi-chapter: toggle chapter grid
        const existing = item.querySelector('.chapter-grid-wrap');
        if (existing) { collapseGrid(existing); return; }
        // Collapse any other expanded book
        const prev = bookList.querySelector('.chapter-grid-wrap');
        collapseGrid(prev);
        buildChapterGrid(item, bi);
      });
      bookList.appendChild(item);
    }
    bookListBuilt = true;
  }

  // Update current states
  bookList.querySelectorAll('.book-item').forEach(el => {
    const b = parseInt(el.dataset.book);
    el.classList.toggle('current', b === curBi);
  });
  // Remove any lingering grids instantly (nav was closed)
  bookList.querySelectorAll('.chapter-grid-wrap').forEach(w => w.remove());

  // Auto-expand current book's chapters
  const currentItem = bookList.querySelector('.current');
  if (currentItem && CHAPTERS[curBi] > 1) {
    buildChapterGrid(currentItem, curBi);
  }

  nav.classList.add('open');
  if (currentItem) {
    requestAnimationFrame(() => {
      currentItem.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  }
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
    wrap.addEventListener('click', () => wrap.classList.toggle('expanded'));
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
    const widths = [100, 85, 92, 78, 95, 60];
    for (let i = 0; i < 6; i++) {
      const line = document.createElement('div');
      line.className = 'skeleton-line';
      line.style.width = widths[i] + '%';
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
    // Fade in content that was behind a skeleton
    if (willFade) {
      scroll.style.opacity = '0';
      scroll.offsetWidth;
      scroll.style.transition = 'opacity 0.2s ease-out';
      scroll.style.opacity = '1';
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

// Fill all 3 panels from scratch (used for init + nav jumps)
function fillAllPanels() {
  fillPanel(panels[0], pos > 0 ? pos - 1 : null);
  fillPanel(panels[1], pos);
  fillPanel(panels[2], pos < TOTAL - 1 ? pos + 1 : null);
  resetTrack();
  updateHeader();
  bindScrollShadow();
}

// Reset track to center position with no transition
function resetTrack() {
  track.style.transition = 'none';
  track.style.transform = 'translateX(-33.333%)';
  // Force reflow so the browser applies transition:none before any future transition
  track.offsetWidth;
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
  if (np < 0 || np >= TOTAL) {
    // Rubber-band: spring back with a gentle settle curve
    track.style.transition = 'transform 0.4s cubic-bezier(0.25,0.46,0.45,0.94)';
    track.style.transform = 'translateX(-33.333%)';
    setPanelTransitions(0.4);
    clearPanelEffects();
    return;
  }
  sliding = true;

  // Scale duration with velocity: fast flick ~150ms, slow drag ~300ms
  const vel = velocity || 0;
  const dur = Math.max(0.12, Math.min(0.35, 0.3 / (1 + vel * 2)));

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
  }

  track.addEventListener('transitionend', onDone, { once: true });
  const safety = setTimeout(onDone, dur * 1000 + 100);
}

// --- TOUCH HANDLING ---
let sx = 0, sy = 0, dx = 0, drag = false, horiz = null;
let touchStartTime = 0, containerW = 0, rafId = null;

container.addEventListener('touchstart', e => {
  if (sliding) return;
  sx = e.touches[0].clientX;
  sy = e.touches[0].clientY;
  dx = 0; drag = true; horiz = null;
  touchStartTime = Date.now();
  containerW = container.offsetWidth;
  track.style.transition = 'none';
  clearPanelEffects();
}, { passive: true });

container.addEventListener('touchmove', e => {
  if (!drag || sliding) return;
  const mx = e.touches[0].clientX - sx;
  const my = e.touches[0].clientY - sy;
  if (horiz === null && (Math.abs(mx) > 6 || Math.abs(my) > 6)) {
    horiz = Math.abs(mx) > Math.abs(my);
  }
  if (horiz === false) { drag = false; return; }
  if (horiz) {
    e.preventDefault();
    dx = mx;
    if (!rafId) rafId = requestAnimationFrame(applyDrag);
  }
}, { passive: false });

function applyDrag() {
  rafId = null;
  // Rubber-band at boundaries: diminishing returns via sqrt
  let visualDx = dx;
  const atStart = pos === 0 && dx > 0;
  const atEnd = pos === TOTAL - 1 && dx < 0;
  if (atStart || atEnd) {
    const sign = dx > 0 ? 1 : -1;
    visualDx = sign * Math.sqrt(Math.abs(dx)) * 3;
  }
  const pct = -33.333 + visualDx / containerW * 33.333;
  track.style.transform = 'translateX(' + pct + '%)';

  // Per-panel depth effects (skip at boundaries)
  if (!atStart && !atEnd) {
    applyPanelEffects(visualDx / containerW);
  }
}

container.addEventListener('touchend', () => {
  if (!drag || !horiz) { drag = false; return; }
  drag = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  // Boundary: just spring back
  const atStart = pos === 0 && dx > 0;
  const atEnd = pos === TOTAL - 1 && dx < 0;
  if (atStart || atEnd) {
    track.style.transition = 'transform 0.4s cubic-bezier(0.25,0.46,0.45,0.94)';
    track.style.transform = 'translateX(-33.333%)';
    return;
  }

  // Velocity-adaptive threshold
  const elapsed = Date.now() - touchStartTime || 1;
  const velocity = Math.abs(dx) / elapsed; // px/ms
  const distRatio = Math.abs(dx) / containerW;
  // Fast flick (>0.5 px/ms): commit at 8%; slow drag: require 15%
  const velT = Math.max(0, Math.min(1, (velocity - 0.1) / 0.4));
  const threshold = 0.15 - velT * 0.07;

  if (distRatio > threshold) {
    slideTo(dx < 0 ? 1 : -1, velocity);
  } else {
    // Snap back — duration proportional to how far we dragged
    const snapDur = Math.max(0.15, Math.min(0.3, distRatio * 2));
    const snapEase = reduceMotion ? 'cubic-bezier(0.16,1,0.3,1)' : 'cubic-bezier(0.25,1.1,0.35,1)';
    track.style.transition = 'transform ' + snapDur + 's ' + snapEase;
    track.style.transform = 'translateX(-33.333%)';
    setPanelTransitions(snapDur);
    clearPanelEffects();
  }
});

// --- POPSTATE (back/forward) ---
window.addEventListener('popstate', (e) => {
  if (sliding) return;
  const newPos = e.state?.pos ?? posFromPath();
  if (newPos !== pos && newPos >= 0 && newPos < TOTAL) {
    pos = newPos;
    fillAllPanels();
  }
});

// --- INIT ---
fillAllPanels();
history.replaceState({ pos }, '', '/' + toSlug(BOOKS[ALL[pos].bi]) + '/' + (ALL[pos].ch + 1));
