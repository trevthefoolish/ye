/*! Copyright (c) 2026 vapourware.ai All rights reserved. */
// The reader: a three-panel swipe pager over every chapter of the Bible.
// Plain browser JavaScript with no dependencies; the server minifies and
// fingerprints this file at startup (src/http/shell.js).
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const { books: BOOKS, chapters: CHAPTERS, rv: RENDER_VERSION } = JSON.parse($('config').textContent);

  const FOREGROUND = 'foreground';
  const BACKGROUND = 'background';

  // ---------------------------------------------------------------------------
  // Telemetry: anonymous analytics and client error reports, sent as beacons.

  function beacon(url, payload) {
    try {
      const body = JSON.stringify(payload);
      if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      else fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    } catch { /* telemetry must never break reading */ }
  }
  const sendEvent = (type, data) => beacon('/api/ev', { type, ...data });
  const reportError = (type, msg) => beacon('/api/log', { type, msg: String(msg).slice(0, 500), url: location.pathname });

  window.addEventListener('error', e => reportError('onerror', `${e.message} at ${e.filename}:${e.lineno}:${e.colno}`));
  window.addEventListener('unhandledrejection', e => reportError('unhandled', e.reason?.message || String(e.reason)));

  // ---------------------------------------------------------------------------
  // Canon. Every chapter has a flat index p: Genesis 1 is 0, Revelation 22 is 1188.

  const LOCATIONS = [];
  const BOOK_START = CHAPTERS.map((count, bi) => {
    const start = LOCATIONS.length;
    for (let chapter = 1; chapter <= count; chapter++) LOCATIONS.push({ bi, chapter });
    return start;
  });
  const TOTAL = LOCATIONS.length;
  const BOOK_BY_NAME = new Map(BOOKS.map((name, bi) => [name.toLowerCase(), bi]));

  const at = p => LOCATIONS[p];
  const indexOf = (bi, chapter) => BOOK_START[bi] + chapter - 1;
  const inRange = p => (p >= 0 && p < TOTAL ? p : null);
  const titleOf = p => `${BOOKS[at(p).bi]} ${at(p).chapter}`;
  const slug = name => name.toLowerCase().replace(/ /g, '-');
  const pathOf = p => `/${slug(BOOKS[at(p).bi])}/${at(p).chapter}`;
  const DEFAULT_P = indexOf(BOOK_BY_NAME.get('ecclesiastes'), 1);

  function parsePath(pathname) {
    try {
      const parts = decodeURIComponent(pathname).split('/').filter(Boolean);
      const bi = parts.length === 2 ? BOOK_BY_NAME.get(parts[0].replace(/-/g, ' ').toLowerCase()) : undefined;
      const chapter = Number(parts[1]);
      if (bi === undefined || !Number.isInteger(chapter) || chapter < 1 || chapter > CHAPTERS[bi]) return null;
      return indexOf(bi, chapter);
    } catch {
      return null;
    }
  }

  // The server reads this cookie to send "/" back to where the reader left off.
  function rememberPosition(p) {
    const { bi, chapter } = at(p);
    const secure = location.protocol === 'https:' ? ';Secure' : '';
    document.cookie = `lastPos=${bi}:${chapter - 1};path=/;max-age=31536000;SameSite=Lax${secure}`;
  }

  // ---------------------------------------------------------------------------
  // Motion. Shared durations and easing come from the design tokens in
  // style.css; gesture physics (tuned by feel on devices) live here.

  const css = getComputedStyle(document.documentElement);
  const token = name => css.getPropertyValue(name).trim();
  const TOKENS = {
    blink: parseFloat(token('--dur-blink')),
    breath: parseFloat(token('--dur-breath')),
    settle: parseFloat(token('--dur-settle')),
    stagger: parseFloat(token('--delay-stagger')),
    easeOut: token('--ease-out'),
    smoke: parseFloat(token('--opacity-smoke')),
  };

  const MOTION = {
    slideMin: 0.12,      // s, fastest committed swipe
    slideMax: 0.35,      // s, slowest committed swipe
    spring: 0.4,         // s, spring back from a boundary
    jumpOut: 0.15,       // s, fade out before a history jump
    jumpIn: 0.2,         // s, fade back in
    safetyMs: 100,       // added to transition timeouts in case transitionend never fires
    easeSpring: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    easeSlide: 'cubic-bezier(0.16, 1, 0.3, 1)',
    easeFlick: 'cubic-bezier(0.22, 1.15, 0.36, 1)',
    easeToss: 'cubic-bezier(0.175, 0.885, 0.32, 1.05)',
    easeSnap: 'cubic-bezier(0.25, 1.1, 0.35, 1)',
  };

  const SWIPE = {
    lockPx: 6,           // movement before the gesture commits to horizontal or vertical
    commitSlow: 0.15,    // fraction of width a slow drag must cover to turn the page
    commitRange: 0.07,   // how much a fast drag lowers that threshold
    velSlow: 0.1,        // px/ms where the threshold starts dropping
    velFast: 0.4,        // px/ms over which it drops fully
    velToss: 0.2,        // px/ms above which the slide uses the toss curve
    velFlick: 0.6,       // px/ms above which it uses the flick curve
    durBase: 0.3,        // s, slide duration at zero velocity
    durScale: 2,         // how quickly velocity shortens it
    rubberBand: 3,       // resistance past the first and last chapter
    glowMax: 0.2,
    glowDivisor: 200,
  };

  const DEPTH = {
    inScale: 0.92,       // incoming panel grows from this scale
    outScale: 0.96,      // outgoing panel shrinks to this scale
    outDim: 0.85,        // and dims to this brightness
    shadowX: 8,
    shadowBlur: 13,
    shadowOpacity: 0.11,
    shadowMin: 0.02,     // drag progress below which the shadow is omitted
  };

  // Runs fn once el finishes transitioning `prop` (any property if null), or
  // after timeoutMs if transitionend never arrives.
  function afterTransition(el, prop, timeoutMs, fn) {
    const done = e => {
      // Ignore transitions bubbling up from descendants.
      if (e && (e.target !== el || (prop && e.propertyName !== prop))) return;
      el.removeEventListener('transitionend', done);
      clearTimeout(timer);
      fn();
    };
    el.addEventListener('transitionend', done);
    const timer = setTimeout(done, timeoutMs);
  }

  const whenIdle = fn => (window.requestIdleCallback ? requestIdleCallback(fn) : setTimeout(fn, 200));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------------------
  // Chapter data. The server answers immediately with whatever is rendered
  // (null for verses still rendering) and renders the rest in the background,
  // sharing each verse as the model finishes it; chapters on screen are polled
  // until complete. Foreground requests go ahead of background (prefetch) ones.

  const POLL = {
    timeoutMs: 35_000,
    defaultDelayMs: 2_000,
    maxErrors: 5,
    maxErrorDelayMs: 30_000,
    // Only polls that bring no new verses count, so a slow but progressing
    // render is never abandoned; a wedged server eventually is.
    maxIdlePolls: 90,
  };

  const chapters = (() => {
    const cache = new Map();     // p -> { verses, complete }
    const inflight = new Map();  // "p:priority" -> Promise
    const watchers = new Map();  // p -> Set of { priority, onData, onError }
    const polls = new Map();     // p -> { timer, errors, idle, rendered }

    const renderedCount = data => data.verses.reduce((n, v) => n + (v ? 1 : 0), 0);

    // Keeps the most complete copy and tells watchers when it improves.
    function remember(p, data) {
      if (!data?.verses?.length) return;
      const next = { verses: data.verses, complete: data.complete !== false };
      const prev = cache.get(p);
      if (prev && (prev.complete || (!next.complete && renderedCount(next) <= renderedCount(prev)))) return;
      cache.set(p, next);
      for (const w of watchers.get(p) || []) w.onData(next);
    }

    function request(p, priority) {
      const key = `${p}:${priority}`;
      if (inflight.has(key)) return inflight.get(key);
      const { bi, chapter } = at(p);
      const params = new URLSearchParams({ v: RENDER_VERSION });
      if (priority === BACKGROUND) params.set('priority', BACKGROUND);
      const promise = fetch(`/api/chapter/${slug(BOOKS[bi])}/${chapter}?${params}`, { signal: AbortSignal.timeout(POLL.timeoutMs) })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(data => {
          remember(p, data);
          return data;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    }

    // At most one request; none if the chapter is already complete.
    function load(p, priority) {
      const cached = cache.get(p);
      return cached?.complete ? Promise.resolve(cached) : request(p, priority);
    }

    const priorityOf = p => {
      for (const w of watchers.get(p) || []) if (w.priority === FOREGROUND) return FOREGROUND;
      return BACKGROUND;
    };

    function poll(p, delayMs) {
      let state = polls.get(p);
      if (!state) polls.set(p, state = { timer: 0, errors: 0, idle: 0, rendered: -1 });
      clearTimeout(state.timer);
      state.timer = setTimeout(() => tick(p, state), delayMs);
    }

    function stopPolling(p) {
      clearTimeout(polls.get(p)?.timer);
      polls.delete(p);
    }

    async function tick(p, state) {
      if (!watchers.get(p)?.size || cache.get(p)?.complete) return stopPolling(p);
      try {
        const data = await request(p, priorityOf(p));
        state.errors = 0;
        const rendered = renderedCount(data);
        state.idle = rendered > state.rendered ? 0 : state.idle + 1;
        state.rendered = rendered;
        if (data.complete === false && state.idle < POLL.maxIdlePolls) poll(p, data.retryAfterMs || POLL.defaultDelayMs);
        else stopPolling(p);
      } catch (err) {
        reportError('chapter_load', `${titleOf(p)}: ${err.message}`);
        for (const w of watchers.get(p) || []) w.onError(err);
        state.errors++;
        if (state.errors < POLL.maxErrors) poll(p, Math.min(POLL.maxErrorDelayMs, 1000 * 2 ** state.errors));
        else stopPolling(p);
      }
    }

    // Keeps p fresh while watched. A foreground watcher polls at foreground
    // priority; promoting one re-polls at once (and restarts a poll that gave up).
    function watch(p, priority, onData, onError) {
      const w = { priority, onData, onError };
      if (!watchers.has(p)) watchers.set(p, new Set());
      watchers.get(p).add(w);
      if (!cache.get(p)?.complete) poll(p, 0);
      return {
        setPriority(next) {
          const promoted = next === FOREGROUND && w.priority !== FOREGROUND;
          w.priority = next;
          if (promoted && !cache.get(p)?.complete) poll(p, 0);
        },
        stop() {
          const set = watchers.get(p);
          set?.delete(w);
          if (set && set.size === 0) {
            watchers.delete(p);
            stopPolling(p);
          }
        },
      };
    }

    return { get: p => cache.get(p), remember, load, watch };
  })();

  // ---------------------------------------------------------------------------
  // Panels. Each of the three track panels shows one chapter: skeleton lines
  // until verses arrive, then verses in place of each skeleton as they render.

  const SKELETON_WIDTHS = [100, 85, 92, 78, 95, 60];
  const SCROLL_MEMORY_MAX = 50;
  const scrollMemory = new Map(); // p -> scrollTop, least recently used first

  function skeletonLine(i) {
    const line = el('div', 'skeleton-line');
    line.style.width = SKELETON_WIDTHS[i % SKELETON_WIDTHS.length] + '%';
    return line;
  }

  function verseBlock(verse) {
    const block = el('div', 'verse-wrap');
    const note = el('div', 'note');
    note.append(el('div', 'note-inner', verse.note));
    block.append(el('div', null, verse.rendering), note);
    return block;
  }

  function chapterFooter() {
    const copyright = el('p', 'copyright', '© 2026 vapourware.ai');
    copyright.append(el('br'), 'All rights reserved.');
    return [copyright, el('div', 'spacer')];
  }

  class Panel {
    constructor(node) {
      this.node = node;
      this.scroll = node.querySelector('.chapter-scroll');
      this.p = null;
      this.priority = BACKGROUND;
      this.slots = null;   // one element per verse once the verse count is known
      this.watcher = null;
    }

    // Shows chapter p (null for beyond either end of the Bible). Watching (and
    // so fetching) can wait for `after`, letting the visible chapter go first.
    show(p, priority, after) {
      this.priority = priority;
      if (p === this.p) {
        if (this.watcher) this.watcher.setPriority(priority);
        else if (priority === FOREGROUND) this.watch(p); // became visible before its turn
        return;
      }
      this.leave();
      this.p = p;
      this.slots = null;
      this.scroll = el('div', 'chapter-scroll');
      this.node.replaceChildren(this.scroll);
      if (p === null) return;

      const cached = chapters.get(p);
      if (cached) {
        this.fill(cached);
        this.restoreScroll();
      } else {
        for (let i = 0; i < SKELETON_WIDTHS.length; i++) this.scroll.append(skeletonLine(i));
      }
      if (after) after.then(() => this.watch(p));
      else this.watch(p);
    }

    watch(p) {
      if (this.p !== p || this.watcher) return;
      this.watcher = chapters.watch(p, this.priority, data => this.update(data), () => this.failed());
    }

    leave() {
      if (this.p !== null && this.slots) {
        scrollMemory.delete(this.p);
        scrollMemory.set(this.p, this.scroll.scrollTop);
        if (scrollMemory.size > SCROLL_MEMORY_MAX) scrollMemory.delete(scrollMemory.keys().next().value);
      }
      this.watcher?.stop();
      this.watcher = null;
    }

    restoreScroll() {
      const top = scrollMemory.get(this.p);
      if (top) this.scroll.scrollTop = top;
    }

    update(data) {
      const firstContent = !this.slots;
      this.fill(data);
      if (!firstContent) return;
      this.restoreScroll();
      // Fade in content that replaces the loading skeleton.
      const scroll = this.scroll;
      scroll.style.opacity = '0';
      void scroll.offsetWidth; // flush so the transition starts from 0
      scroll.style.transition = `opacity ${TOKENS.breath}s ${TOKENS.easeOut}`;
      scroll.style.opacity = '1';
      scroll.addEventListener('transitionend', () => { scroll.style.transition = ''; }, { once: true });
    }

    // Builds the verse list once, then swaps in verses as they render, so
    // open notes and the scroll position are never disturbed.
    fill(data) {
      if (!this.slots) {
        this.slots = data.verses.map((verse, i) => (verse ? verseBlock(verse) : skeletonLine(i)));
        this.scroll.replaceChildren(...this.slots, ...chapterFooter());
        return;
      }
      data.verses.forEach((verse, i) => {
        const slot = this.slots[i];
        if (verse && slot?.classList.contains('skeleton-line')) {
          this.slots[i] = verseBlock(verse);
          slot.replaceWith(this.slots[i]);
        }
      });
    }

    // Only replaces emptiness; verses already on screen stay.
    failed() {
      if (!this.slots) this.scroll.replaceChildren(el('div', 'empty-msg', 'Could not load this chapter. Try again shortly.'));
    }
  }

  // ---------------------------------------------------------------------------
  // Reader: header, pager, navigator, and history.

  const header = $('header');
  const reading = $('reading');
  const container = $('swipe-container');
  const track = $('swipe-track');
  const edgeLeft = $('edge-glow-left');
  const edgeRight = $('edge-glow-right');
  const nav = $('nav');
  const bookList = $('book-list');

  // panels[0] is the previous chapter, [1] the current, [2] the next. The
  // ring rotates in place after each slide so no panel is ever rebuilt twice.
  const panels = Array.from(track.children, node => new Panel(node));
  const TRACK_CENTER = 'translateX(-33.333%)';

  let pos = null;
  let sliding = false;
  let navOpen = false;
  let pendingPop = null;
  let views = 0;
  const gesture = { x0: 0, y0: 0, dx: 0, t0: 0, width: 0, active: false, horizontal: null, frame: 0 };

  function updateHeaderShadow() {
    header.classList.toggle('scrolled', panels[1].scroll.scrollTop > 0);
  }

  function onPositionChange() {
    const title = titleOf(pos);
    document.title = title;
    header.textContent = title;
    const url = pathOf(pos);
    // A chapter picked in the navigator replaces the navigator's history entry.
    if (history.state?.nav) history.replaceState({ pos }, '', url);
    else if (location.pathname !== url) history.pushState({ pos }, '', url);
    rememberPosition(pos);
    views++;
    sendEvent('view', { book: BOOKS[at(pos).bi], ch: at(pos).chapter });
    updateHeaderShadow();
  }

  function prefetch(p) {
    if (inRange(p) === null) return;
    whenIdle(() => chapters.load(p, BACKGROUND).catch(err => reportError('prefetch', err.message)));
  }

  // Jumps straight to p (start, navigator, history). Neighbors load once the
  // visible chapter has answered; the returned promise settles then too.
  function showChapter(p) {
    pos = p;
    const current = chapters.load(p, FOREGROUND).catch(() => {});
    panels[1].show(p, FOREGROUND);
    panels[0].show(inRange(p - 1), BACKGROUND, current);
    panels[2].show(inRange(p + 1), BACKGROUND, current);
    resetTrack();
    onPositionChange();
    return current;
  }

  function jumpTo(p) {
    if (p === pos) return;
    reading.style.transition = `opacity ${MOTION.jumpOut}s ${TOKENS.easeOut}`;
    reading.style.opacity = '0';
    setTimeout(() => {
      showChapter(p);
      reading.style.transition = `opacity ${MOTION.jumpIn}s ${TOKENS.easeOut}`;
      reading.style.opacity = '1';
    }, MOTION.jumpOut * 1000);
  }

  // --- Track and depth effects ---

  function resetTrack() {
    track.style.transition = 'none';
    track.style.transform = TRACK_CENTER;
    void track.offsetWidth; // flush so the next transition starts from center
  }

  function setPanelTransitions(seconds) {
    const t = ['transform', 'opacity', 'filter', 'box-shadow'].map(prop => `${prop} ${seconds}s ${TOKENS.easeOut}`).join(', ');
    for (const panel of panels) panel.node.style.transition = t;
  }

  function clearPanelEffects() {
    for (const { node } of panels) {
      node.style.transform = 'translateZ(0)';
      node.style.opacity = '';
      node.style.filter = '';
      node.style.boxShadow = '';
      node.style.transition = '';
    }
  }

  // progress: drag distance as a fraction of width; negative drags forward.
  function applyPanelEffects(progress) {
    const amount = Math.min(Math.abs(progress), 1);
    const forward = progress < 0;
    const incoming = panels[forward ? 2 : 0].node.style;
    const outgoing = panels[forward ? 0 : 2].node.style;
    incoming.transform = `translateZ(0) scale(${DEPTH.inScale + amount * (1 - DEPTH.inScale)})`;
    incoming.opacity = TOKENS.smoke + amount * (1 - TOKENS.smoke);
    outgoing.transform = `translateZ(0) scale(${1 - amount * (1 - DEPTH.outScale)})`;
    outgoing.filter = `brightness(${1 - amount * (1 - DEPTH.outDim)})`;
    panels[1].node.style.boxShadow = amount > DEPTH.shadowMin
      ? `${progress * DEPTH.shadowX}px 0 ${DEPTH.shadowBlur * amount}px rgba(0,0,0,${DEPTH.shadowOpacity * amount})`
      : 'none';
  }

  function springBack() {
    track.style.transition = `transform ${MOTION.spring}s ${MOTION.easeSpring}`;
    track.style.transform = TRACK_CENTER;
    setPanelTransitions(MOTION.spring);
    clearPanelEffects();
  }

  // Animates one chapter forward (dir 1) or back (dir -1). Faster swipes get
  // shorter, springier slides.
  function slide(dir, velocity = 0) {
    if (sliding) return;
    const target = pos + dir;
    if (inRange(target) === null) return springBack();
    sliding = true;

    const seconds = Math.max(MOTION.slideMin, Math.min(MOTION.slideMax, SWIPE.durBase / (1 + velocity * SWIPE.durScale)));
    const ease = velocity > SWIPE.velFlick ? MOTION.easeFlick : velocity > SWIPE.velToss ? MOTION.easeToss : MOTION.easeSlide;
    track.style.transition = `transform ${seconds}s ${ease}`;
    track.style.transform = `translateX(${dir === 1 ? '-66.666%' : '0%'})`;

    setPanelTransitions(seconds);
    const incoming = panels[1 + dir].node.style;
    const outgoing = panels[1 - dir].node.style;
    incoming.transform = 'translateZ(0) scale(1)';
    incoming.opacity = '1';
    outgoing.transform = `translateZ(0) scale(${DEPTH.outScale})`;
    outgoing.filter = `brightness(${DEPTH.outDim})`;
    panels[1].node.style.boxShadow = 'none';

    afterTransition(track, null, seconds * 1000 + MOTION.safetyMs, () => {
      if (dir === 1) {
        track.appendChild(panels[0].node);
        panels.push(panels.shift());
      } else {
        track.insertBefore(panels[2].node, panels[0].node);
        panels.unshift(panels.pop());
      }
      pos = target;
      clearPanelEffects();
      resetTrack();

      const current = chapters.load(pos, FOREGROUND).catch(() => {});
      panels[1].show(pos, FOREGROUND);
      panels[1 - dir].show(inRange(pos - dir), BACKGROUND);
      panels[1 + dir].show(inRange(pos + dir), BACKGROUND, current);
      sendEvent('nav', { method: 'swipe' });
      onPositionChange();
      // Warm the chapter after next so the following swipe is instant too.
      current.then(() => prefetch(target + 2 * dir));

      sliding = false;
      if (pendingPop !== null) {
        const p = pendingPop;
        pendingPop = null;
        jumpTo(p);
      }
    });
  }

  // --- Touch ---

  const atBoundary = dx => (pos === 0 && dx > 0) || (pos === TOTAL - 1 && dx < 0);

  function clearEdgeGlow() {
    edgeLeft.style.opacity = '0';
    edgeRight.style.opacity = '0';
  }

  function applyDrag() {
    gesture.frame = 0;
    const bounded = atBoundary(gesture.dx);
    // Past either end of the Bible the drag resists with diminishing returns.
    const dx = bounded ? Math.sign(gesture.dx) * Math.sqrt(Math.abs(gesture.dx)) * SWIPE.rubberBand : gesture.dx;
    track.style.transform = `translateX(${-33.333 + (dx / gesture.width) * 33.333}%)`;
    if (bounded) {
      const glow = String(Math.min(SWIPE.glowMax, Math.abs(dx) / SWIPE.glowDivisor));
      (gesture.dx > 0 ? edgeLeft : edgeRight).style.opacity = glow;
    } else {
      applyPanelEffects(dx / gesture.width);
    }
  }

  function cancelDragFrame() {
    if (gesture.frame) cancelAnimationFrame(gesture.frame);
    gesture.frame = 0;
  }

  function bindTouch() {
    container.addEventListener('touchstart', e => {
      if (sliding) return;
      gesture.x0 = e.touches[0].clientX;
      gesture.y0 = e.touches[0].clientY;
      gesture.dx = 0;
      gesture.t0 = Date.now();
      gesture.width = container.offsetWidth;
      gesture.active = true;
      gesture.horizontal = null;
      track.style.transition = 'none';
      clearPanelEffects();
    }, { passive: true });

    container.addEventListener('touchmove', e => {
      if (!gesture.active || sliding) return;
      const mx = e.touches[0].clientX - gesture.x0;
      const my = e.touches[0].clientY - gesture.y0;
      if (gesture.horizontal === null && (Math.abs(mx) > SWIPE.lockPx || Math.abs(my) > SWIPE.lockPx)) {
        gesture.horizontal = Math.abs(mx) > Math.abs(my);
      }
      if (gesture.horizontal === false) {
        gesture.active = false; // vertical: leave it to native scrolling
        return;
      }
      if (gesture.horizontal) {
        e.preventDefault();
        gesture.dx = mx;
        gesture.frame ||= requestAnimationFrame(applyDrag);
      }
    }, { passive: false });

    container.addEventListener('touchcancel', () => {
      if (!gesture.active) return;
      gesture.active = false;
      cancelDragFrame();
      clearEdgeGlow();
      springBack();
    });

    container.addEventListener('touchend', () => {
      if (!gesture.active || !gesture.horizontal) {
        gesture.active = false;
        return;
      }
      gesture.active = false;
      cancelDragFrame();
      clearEdgeGlow();
      if (atBoundary(gesture.dx)) return springBack();

      // Fast drags need less distance to turn the page.
      const velocity = Math.abs(gesture.dx) / (Date.now() - gesture.t0 || 1); // px/ms
      const distance = Math.abs(gesture.dx) / gesture.width;
      const speed = Math.max(0, Math.min(1, (velocity - SWIPE.velSlow) / SWIPE.velFast));
      if (distance > SWIPE.commitSlow - speed * SWIPE.commitRange) {
        slide(gesture.dx < 0 ? 1 : -1, velocity);
      } else {
        // Snap back, quicker for shorter drags.
        const seconds = Math.max(TOKENS.blink, Math.min(TOKENS.settle, distance * 2));
        track.style.transition = `transform ${seconds}s ${MOTION.easeSnap}`;
        track.style.transform = TRACK_CENTER;
        setPanelTransitions(seconds);
        clearPanelEffects();
      }
    });

    // Tap a verse to open or close its note (but not at the end of a swipe).
    track.addEventListener('click', e => {
      const verse = e.target.closest('.verse-wrap');
      if (verse && !sliding && !gesture.horizontal) verse.classList.toggle('expanded');
    });

    // scroll does not bubble; capture it for whichever panel is current.
    track.addEventListener('scroll', e => {
      if (e.target === panels[1].scroll) updateHeaderShadow();
    }, { capture: true, passive: true });
  }

  // --- Navigator: every book, each expanding to a grid of its chapters ---

  function buildBookList() {
    const { bi: currentBook } = at(pos);
    bookList.replaceChildren(...BOOKS.map((name, bi) => {
      const item = el('div', bi === currentBook ? 'book-item current expanded' : 'book-item');
      const grid = el('div', 'chapter-grid');
      for (let chapter = 1; chapter <= CHAPTERS[bi]; chapter++) {
        const p = indexOf(bi, chapter);
        const pill = el('span', p === pos ? 'chapter-pill current' : 'chapter-pill', String(chapter));
        pill.dataset.p = String(p);
        grid.append(pill);
      }
      const wrap = el('div', 'chapter-grid-wrap');
      wrap.append(grid);
      item.append(el('span', 'book-name', name), wrap);
      return item;
    }));
  }

  function openNav() {
    if (sliding || navOpen) return;
    buildBookList();
    navOpen = true;
    history.pushState({ nav: true, pos }, '');
    nav.scrollTop = 0;
    nav.classList.remove('curtain');
    nav.classList.add('open');
    bookList.querySelector('.book-item.current')?.scrollIntoView({ block: 'center' });
  }

  // The list fades out while the opaque "curtain" stays up, so whatever
  // changes underneath (a new chapter) is revealed only once it is ready.
  function fadeNavOut(then) {
    nav.classList.remove('open');
    nav.classList.add('curtain');
    afterTransition(bookList, 'opacity', (TOKENS.breath + TOKENS.stagger) * 1000 + MOTION.safetyMs, () => {
      if (!navOpen) nav.classList.remove('curtain');
      then?.();
    });
  }

  function closeNav(viaHistory = false) {
    if (!navOpen) return;
    navOpen = false;
    fadeNavOut();
    // Consume the entry openNav pushed so Back does not land on it later.
    if (!viaHistory && history.state?.nav) history.back();
  }

  function toggleBook(item) {
    const opening = !item.classList.contains('expanded');
    const open = bookList.querySelector('.book-item.expanded');
    if (open && open !== item) open.classList.remove('expanded');
    item.classList.toggle('expanded', opening);
    if (opening) {
      const wrap = item.querySelector('.chapter-grid-wrap');
      afterTransition(wrap, 'grid-template-rows', TOKENS.settle * 1000 + MOTION.safetyMs, () => {
        item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
  }

  function bindNavigator() {
    header.addEventListener('click', openNav);
    nav.addEventListener('click', e => {
      const pill = e.target.closest('.chapter-pill');
      if (pill) {
        const p = Number(pill.dataset.p);
        if (p === pos) return closeNav();
        navOpen = false;
        fadeNavOut(() => {
          sendEvent('nav', { method: 'tap' });
          showChapter(p);
        });
        return;
      }
      const name = e.target.closest('.book-name');
      if (name) return toggleBook(name.parentElement);
      // Taps between pills do nothing; anywhere else closes.
      if (!e.target.closest('.chapter-grid')) closeNav();
    });
  }

  function bindHistory() {
    window.addEventListener('popstate', e => {
      if (navOpen) return closeNav(true);
      const p = Number.isInteger(e.state?.pos) ? e.state.pos : parsePath(location.pathname);
      if (p === null) return;
      // Mid-slide: apply once the slide settles so URL and content stay in sync.
      if (sliding) pendingPop = p;
      else jumpTo(p);
    });
  }

  // ---------------------------------------------------------------------------
  // Start.

  function seedFromPage() {
    try {
      const preloaded = $('preloaded');
      if (!preloaded) return;
      const data = JSON.parse(preloaded.textContent);
      const bi = BOOK_BY_NAME.get(String(data.book).toLowerCase());
      if (bi !== undefined && data.ch >= 1 && data.ch <= CHAPTERS[bi]) chapters.remember(indexOf(bi, data.ch), data);
    } catch (err) {
      reportError('preload_parse', err.message);
    }
  }

  function start() {
    seedFromPage();
    const p = parsePath(location.pathname) ?? DEFAULT_P;
    // Canonicalize before showChapter so a non-canonical URL is replaced, not pushed past.
    history.replaceState({ pos: p }, '', pathOf(p));
    bindTouch();
    bindNavigator();
    bindHistory();
    showChapter(p).then(() => {
      prefetch(p + 2);
      prefetch(p - 2);
    });
  }

  // Wider screens see the "designed for mobile" message instead (CSS), so
  // don't fetch or render chapters for them unless the window narrows.
  const wide = matchMedia('(min-width: 480px)');
  if (!wide.matches) {
    start();
  } else {
    wide.addEventListener('change', function narrowed() {
      if (wide.matches) return;
      wide.removeEventListener('change', narrowed);
      start();
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && views > 0) sendEvent('session', { depth: views });
  });

  // loadEventEnd is only set once load handlers finish, hence the extra tick.
  window.addEventListener('load', () => setTimeout(() => {
    const timing = performance.getEntriesByType('navigation')[0];
    if (timing) sendEvent('perf', { loadMs: timing.loadEventEnd - timing.startTime, ttiMs: timing.domInteractive - timing.startTime });
  }, 0));
})();
