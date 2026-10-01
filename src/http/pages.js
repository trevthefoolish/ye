// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// HTML and SEO routes: chapter pages with per-chapter metadata and inlined
// chapter data, the root redirect, robots.txt, and sitemap.xml.

const express = require('express');
const { BOOKS, CHAPTER_COUNTS, chapterPath, resolveChapter, toSlug } = require('../canon');
const { jsonForScript } = require('../text');
const { parseCookie } = require('./telemetry');

const DEFAULT_PATH = '/ecclesiastes/1';
const ONE_DAY = 'public, max-age=86400';
const IMMUTABLE = 'public, max-age=31536000, immutable';

// Anything whose last path segment has a dot is a file request, never a page.
const isAssetPath = p => (p.split('/').pop() || '').includes('.');

// The client stores its position as "bookIndex:chapterIndex" (0-based).
function lastPositionPath(cookieHeader) {
  const match = /^(\d+):(\d+)$/.exec(parseCookie(cookieHeader, 'lastPos') || '');
  if (!match) return null;
  const bookIndex = Number(match[1]);
  const chapter = Number(match[2]) + 1;
  return bookIndex < BOOKS.length && chapter <= CHAPTER_COUNTS[bookIndex] ? chapterPath(bookIndex, chapter) : null;
}

function jsonLd(origin, ref, canonical) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    name: `${ref.book} ${ref.chapter}`,
    url: canonical,
    isPartOf: { '@type': 'Book', name: 'The Bible' },
    breadcrumb: {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: origin + '/' },
        { '@type': 'ListItem', position: 2, name: ref.book, item: origin + chapterPath(ref.bookIndex, 1) },
        { '@type': 'ListItem', position: 3, name: `Chapter ${ref.chapter}` },
      ],
    },
  };
}

function sitemap(origin) {
  const urls = [`  <url><loc>${origin}/</loc></url>`];
  BOOKS.forEach((book, bookIndex) => {
    for (let chapter = 1; chapter <= CHAPTER_COUNTS[bookIndex]; chapter++) {
      urls.push(`  <url><loc>${origin}/${toSlug(book)}/${chapter}</loc></url>`);
    }
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.join('\n') + '\n</urlset>';
}

function pageRoutes({ shell, store, origin }) {
  const router = express.Router();
  let sitemapXml = null;

  router.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
  });

  router.get('/sitemap.xml', (req, res) => {
    sitemapXml ??= sitemap(origin);
    res.setHeader('Cache-Control', ONE_DAY);
    res.type('application/xml').send(sitemapXml);
  });

  router.get(shell.script.path, (req, res) => {
    res.setHeader('Cache-Control', IMMUTABLE);
    res.type('js').send(shell.script.body);
  });

  router.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

  router.get('/', (req, res) => {
    res.redirect(302, lastPositionPath(req.headers.cookie) || DEFAULT_PATH);
  });

  router.get('/:book/:chapter', (req, res, next) => {
    const ref = resolveChapter(req.params.book, req.params.chapter);
    if (!ref) return next();
    const title = `${ref.book} ${ref.chapter}`;
    // Canonicalize from the book name so "/1%20kings/1" still yields "/1-kings/1".
    const canonical = origin + chapterPath(ref.bookIndex, ref.chapter);
    const { verses, missing } = store.chapter(ref);
    const first = verses.find(Boolean);
    // Inline whatever is already rendered so the first paint needs no fetch.
    const preloaded = first
      ? `<script id="preloaded" type="application/json">${jsonForScript({ book: ref.book, ch: ref.chapter, verses, complete: missing.length === 0, missingCount: missing.length })}</script>`
      : '';
    res.type('html').send(shell.render({
      title,
      canonical,
      // A stale rendering still beats generic copy for the meta description.
      description: first?.rendering
        ?? store.anyRendering({ ...ref, verse: 1 })
        ?? `${title}, rendered in modern English with scholarly notes.`,
      jsonLd: jsonForScript(jsonLd(origin, ref, canonical)),
      preloaded,
    }));
  });

  // Unknown pages go to the default chapter; unknown files are plain 404s.
  router.get('/{*rest}', (req, res) => {
    if (isAssetPath(req.path)) return res.status(404).end();
    res.redirect(302, DEFAULT_PATH);
  });

  return router;
}

module.exports = { DEFAULT_PATH, isAssetPath, pageRoutes };
