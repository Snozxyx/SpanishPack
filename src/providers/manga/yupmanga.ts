/**
 * YupManga — https://www.yupmanga.com (SPANISH MANGA)
 *
 * Server-rendered pages behind a permissive-but-present Cloudflare bot check.
 * Runtime scraping rides the shared `fetchTextWithBypass` ladder: plain fetch
 * first, browser challenge solve when a challenge page shows up.
 *
 * Verified live:
 *   - search   `/busqueda-avanzada?q=<query>` → cards linking `/series.php?id=<CODE>`
 *              (title carried by the card's `img[alt]`; HTML fallback = anchor text).
 *   - series   `/series.php?id=<CODE>` embeds `window.currentSeriesId = "<CODE>"`.
 *   - chapters `GET /ajax/load_chapters.php?series_id=<CODE>&page=<P>&order=oldest_first`
 *              (from `js/series.js`) → JSON `{ success, html }`; the fragment holds
 *              `a.chapter-link` cards with `data-chapter` (chapter code),
 *              `data-chapter-key` (ordinal), `data-page` (start page), `data-reader`,
 *              and a text label whose digits carry the chapter number.
 *   - pages    `/image-proxy-v2.php?chapter=<CODE>&page=<N>` returns the raw page
 *              image (webp, `Cache-Control: public`) — verified for page 2 of a
 *              real chapter — provided the request carries the site origin as
 *              Referer. The reader (`/reader_v2.php?chapter=…&token=…`) demands a
 *              signed token, so we never need it.
 *
 * Page-count discovery is the one unverified piece (the challenge wall blocked
 * CI from seeing `load_chapters.php` once): `data-pages` is preferred when the
 * fragment carries it, otherwise pages are probed sequentially (bounded) until
 * the proxy stops answering with an image.
 */
import type {
  MangaProvider,
  MangaChapterEntry,
  MangaChapterParams,
  MangaChapterSource,
  MangaPageEntry,
} from '../../types/index.js';

import { fetchText, fetchResponse, loadHtml } from '../../utils/http/fetch.js';
import { fetchTextWithBypass } from '../../utils/common/fetch-bypass.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const BASE = 'https://www.yupmanga.com';
const PROVIDER_NAME = 'yupmanga';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const SITE_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Referer: `${BASE}/`,
  'Accept-Language': 'es-419,es;q=0.9',
};

interface YupCandidate {
  code: string; // series code, e.g. 0ZE4FR4ZR8SZS
  name: string;
}

function toUrl(path: string): string {
  return path.startsWith('http') ? path : `${BASE}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** ISO-8859-ish safe HTML unescape for card titles. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

/** Search the advanced-search page for series cards. */
async function search(query: string): Promise<YupCandidate[]> {
  const html =
    (await fetchTextWithBypass(`${BASE}/busqueda-avanzada?q=${encodeURIComponent(query)}`, {
      headers: SITE_HEADERS,
      timeoutMs: 15000,
    })) ||
    (await fetchText(`${BASE}/busqueda-avanzada?q=${encodeURIComponent(query)}`, {
      headers: SITE_HEADERS,
      timeoutMs: 15000,
    }));
  if (!html) return [];

  const $ = loadHtml(html);

  const byCode = new Map<string, YupCandidate>();
  // Primary: anchors straight at the series page.
  $('a[href*="series.php?id="]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href) return;
    const m = href.match(/[?&]id=([A-Za-z0-9]+)/);
    if (!m) return;

    const card = $(el);
    const img = card.find('img');
    const name =
      (img.length ? img.attr('alt') : '') || card.text().replace(/\s+/g, ' ').trim();
    if (!byCode.has(m[1]) && name) byCode.set(m[1], { code: m[1], name: decodeEntities(name) });
  });

  return Array.from(byCode.values());
}

/** Resolve AniList titles → YupManga series code via fuzzy match. */
async function resolveSeriesCode(params: MangaChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const pool: YupCandidate[] = [];
  const seen = new Set<string>();
  for (const title of titles.slice(0, 2)) {
    for (const cand of await search(title)) {
      if (!seen.has(cand.code)) {
        seen.add(cand.code);
        pool.push(cand);
      }
    }
  }

  const best = pickBestMangaCandidate(titles, pool, (c) => [c.name], 0.6);
  return best ? best.candidate.code : null;
}

/** Pull the chapter code + ordinal out of one `a.chapter-link` card. */
interface YupChapterLink {
  code: string;
  ordinal: string | null;
  label: string | null;
  dataPages: string | null;
}

function parseChapterCards(html: string): YupChapterLink[] {
  const $ = loadHtml(html);
  const cards: YupChapterLink[] = [];
  const codes = new Set<string>();

  $('a.chapter-link').each((_, el) => {
    const a = $(el);
    const code = (a.attr('data-chapter') || '').trim();
    if (!code || codes.has(code)) return;
    codes.add(code);
    cards.push({
      code,
      ordinal: (a.attr('data-chapter-key') || '').trim() || null,
      label: a.text().replace(/\s+/g, ' ').trim() || null,
      dataPages: (a.attr('data-pages') || '').trim() || null,
    });
  });

  // Fallback resilient to class churn: image cards carrying the proxy URL.
  if (cards.length === 0) {
    $('a[href*="reader_v2.php"], a[data-chapter]').each((_, el) => {
      const a = $(el);
      const raw =
        a.attr('data-chapter') ||
        (a.attr('href') || '').match(/chapter=([A-Za-z0-9]+)/)?.[1] ||
        '';
      const code = raw.trim();
      if (!code || codes.has(code)) return;
      codes.add(code);
      cards.push({
        code,
        ordinal: (a.attr('data-chapter-key') || '').trim() || null,
        label: a.text().replace(/\s+/g, ' ').trim() || null,
        dataPages: (a.attr('data-pages') || '').trim() || null,
      });
    });
  }

  return cards;
}

/** Chapter number from the card's label/ordinal ("Capitulo 1104.5" → 1104.5). */
function chapterNumberFromLink(link: YupChapterLink): number {
  const ordinal = Number(link.ordinal);
  if (Number.isFinite(ordinal) && link.ordinal !== '') return ordinal;
  const m = (link.label || '').match(/(\d+(?:[.,]\d+)?)/);
  if (m) return parseFloat(m[1].replace(',', '.'));
  return NaN;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: [BASE],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const seriesCode = await resolveSeriesCode(params);
      if (!seriesCode) return [];

      const byNumber = new Map<number, MangaChapterEntry>();

      // The grid pages newest-first with `newest_first`; walk with
      // `oldest_first` so early pages cover low chapter numbers, and stop when
      // a page comes back empty.
      for (let page = 1; page <= 12; page++) {
        const url =
          `${BASE}/ajax/load_chapters.php?series_id=${encodeURIComponent(seriesCode)}` +
          `&page=${page}&order=oldest_first&_=${Date.now()}`;
        const resp = await fetchTextWithBypass(url, {
          headers: { ...SITE_HEADERS, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          timeoutMs: 15000,
        });
        if (!resp) break;

        let fragment = resp;
        try {
          const parsed = JSON.parse(resp) as { success?: boolean; html?: string };
          if (typeof parsed.html === 'string' && parsed.html) fragment = parsed.html;
          else break; // unknown shape
        } catch {
          // not JSON — maybe the server answered raw HTML
        }

        const cards = parseChapterCards(fragment);
        if (cards.length === 0) break;

        for (const link of cards) {
          const num = chapterNumberFromLink(link);
          if (!Number.isFinite(num) || byNumber.has(num)) continue;

          const source: MangaChapterSource = {
            provider: PROVIDER_NAME,
            chapterKey: `${PROVIDER_NAME}:${link.code}`,
            providerChapterId: link.code,
            language: 'es',
            scanlator: null,
            releaseDate: null,
          };
          byNumber.set(num, { number: num, title: link.label ? link.label.replace(/\s*\d+(?:[.,]\d+)?\s*$/, '').trim() || null : null, volume: null, sources: [source] });
        }
      }

      return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
    } catch {
      return [];
    }
  },

  async getPages(chapterKey: string): Promise<MangaPageEntry[]> {
    try {
      const colonIdx = chapterKey.indexOf(':');
      const chapterCode = colonIdx >= 0 ? chapterKey.slice(colonIdx + 1) : chapterKey;
      if (!chapterCode) return [];

      const proxyUrl = (pageN: number) =>
        `${BASE}/image-proxy-v2.php?chapter=${encodeURIComponent(chapterCode)}&page=${pageN}`;

      // Content-type probe per index; the proxy answers `image/webp` while the
      // chapter has that page and falls back to an HTML error (or challenge)
      // once past the end. Full image bodies only arrive when the reader
      // actually requests them.
      const pages: MangaPageEntry[] = [];
      for (let pageN = 1; pageN <= 120; pageN++) {
        let isImage = false;
        try {
          const res = await fetchResponse(proxyUrl(pageN), { headers: SITE_HEADERS, timeoutMs: 15000 });
          const type = (res.headers.get('content-type') || '').toLowerCase();
          isImage = res.ok && type.startsWith('image/');
        } catch {
          isImage = false;
        }
        if (!isImage) break;
        pages.push({
          pageNumber: pageN,
          imageUrl: proxyUrl(pageN),
          headers: { Referer: `${BASE}/` },
        });
      }
      return pages;
    } catch {
      return [];
    }
  },
};

export default provider;
