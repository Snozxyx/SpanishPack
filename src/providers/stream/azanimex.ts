/**
 * Az-Animex — https://az-animex.com  (SPANISH, fansub hardsub)
 *
 * Az-Animex is a WordPress/Greenshift catalogue; every release page funnels its
 * episodes through a Mirrored.to multilink. The site's own "Server Az" (an
 * AList instance) requires an authenticated guest login and is unusable
 * anonymously, so `single()` walks the Mirrored chain end to end:
 *
 *   1. search    `https://az-animex.com/?s=<query>` → `li.wp-block-post` cards
 *                (title from `img[alt]`, link to `/{slug}/`).
 *   2. series    the title page holds `a[href*="mirrored.to/multilinks/"]`.
 *   3. multilink `www.mirrored.to/multilinks/<ID>` → one /files/<FID>/<name>.mp4_links
 *                entry per episode; the episode number sits in the name
 *                (`…_-_01_[Hakoniwa].mp4_links`).
 *   4. file page `/files/<FID>/<name>.mp4_links` → the exact filename (h3.hdark)
 *                and the "Download" button href carrying `?hash=<tid>`.
 *   5. stats     that page's inline script carries `tmpID`; a single call to
 *                `/mirstats.php?uid=…&tmpID=…&fn=…` renders the host table —
 *                `img alt` = host name, `streamable` rows, link `/getlink/<uid>/<hostId>/?hid=…&tid=…`.
 *   6. getlink   `/getlink/…` returns a page whose `data-clipboard-text` is the
 *                host URL (e.g. `https://streamtape.com/v/…/[Az-Animex]_….mp4`).
 *   7. resolve   the host URL goes through the shared resolver registry
 *                (StreamTape, Luluvid…)

 * Replaying every step was verified request-by-request against the live site
 * (see .tmp/latino-recon/mirstats.html + getlink-body.html). Files are
 * Spanish hardsub fansubs (burned-in subs), so results are stamped `es`.
 */
import type { StreamProvider, SourceOptions, SourceResult, SubtitleTrack } from '../../types/index.js';
import { fetchText, fetchResponse, loadHtml } from '../../utils/http/fetch.js';
import { fetchTextWithBypass } from '../../utils/common/fetch-bypass.js';
import { resolveToDirectOrEmbed } from '../../utils/resolvers/index.js';
import { normalizeTitle, scoreMatch } from '../../utils/scraping/title-normalizer.js';
import { resolveTmdbTarget } from '../../utils/mapping/anizip.js';

const BASE = 'https://az-animex.com';
const MLB = 'https://www.mirrored.to';
const PROVIDER_NAME = 'azanimex';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const AZ_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  'Accept-Language': 'es-419,es;q=0.9',
};
const MLB_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Referer: `${MLB}/`,
};

/**
 * Minimal per-chain cookie jar. Mirrored's file pages hand out a PHP session on
 * the multilink/`_links` pages, and `mirstats.php` binds the `tmpID` to *that*
 * session — requests without the accumulated cookies return an empty table.
 */
class SimpleJar {
  private cookies = new Map<string, string>();

  get size(): number {
    return this.cookies.size;
  }

  absorb(headers: Headers): void {
    const raw = typeof headers.getSetCookie === 'function' ? (headers.getSetCookie() as string[]) : [];
    for (const line of raw) {
      const pair = line.split(';')[0] || '';
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** fetchResponse wrapper that carries + absorbs the jar's cookies. */
async function jarText(
  jar: SimpleJar,
  url: string,
  referer?: string,
  timeoutMs = 15000
): Promise<string | null> {
  try {
    const headers: Record<string, string> = { ...MLB_HEADERS };
    if (jar.size) headers.Cookie = jar.header();
    if (referer) headers.Referer = referer;
    const res = await fetchResponse(url, { headers, timeoutMs, redirect: 'follow' });
    jar.absorb(res.headers);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

interface AzHit {
  href: string;
  title: string;
}

/** Search the WordPress catalogue for matching releases. */
async function search(query: string): Promise<AzHit[]> {
  const html = await fetchText(`${BASE}/?s=${encodeURIComponent(query)}`, {
    headers: AZ_HEADERS,
    timeoutMs: 15000,
  });
  if (!html) return [];

  const $ = loadHtml(html);
  const hits: AzHit[] = [];
  const seen = new Set<string>();

  const push = (href: string, title: string) => {
    href = href.trim();
    if (!href || seen.has(href)) return;
    seen.add(href);
    hits.push({ href: href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`, title });
  };

  // Primary shape (verified): <li class="wp-block-post … fansub-hakoniwa-subs …">
  // wrapping <figure><a href="/{slug}/"><img alt="Title" src=cover>.
  $('li.wp-block-post').each((_, el) => {
    const li = $(el);
    const a = li.find('a').first();
    const href = a.attr('href') || '';
    if (!href) return;
    const img = li.find('img').first();
    const title = (img.attr('alt') || li.text().replace(/\s+/g, ' ').trim() || '').toString();
    push(href, title);
  });

  // Fallback: any anchor into a bare series page.
  if (hits.length === 0) {
    $('a[href^="/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const name = $(el).find('img').attr('alt') || $(el).text().replace(/\s+/g, ' ').trim();
      if (href && name && href.length > 1 && !href.includes('#')) push(href, name);
    });
  }

  return hits;
}

/** Pick the release whose title best matches the ani.zip/AniList titles. */
async function resolveSeriesHref(opts: SourceOptions): Promise<string | null> {
  const target = await resolveTmdbTarget({
    anilistId: opts.anilistId,
    episode: opts.episode,
    titles: opts.titles,
    language: 'es',
  });
  const titles = target.titles.length > 0 ? target.titles : opts.titles;
  if (titles.length === 0) return null;

  const pool: AzHit[] = [];
  const seen = new Set<string>();
  for (const title of titles.slice(0, 3)) {
    for (const hit of await search(title)) {
      if (!seen.has(hit.href)) {
        seen.add(hit.href);
        pool.push(hit);
      }
    }
  }

  const normTargets = titles.map(normalizeTitle).filter(Boolean);
  for (const hit of pool) {
    const norm = normalizeTitle(hit.title);
    if (norm && normTargets.some((t) => t === norm)) return hit.href;
  }

  let best: { href: string; score: number } | null = null;
  for (const hit of pool) {
    const norm = normalizeTitle(hit.title);
    let score = 0;
    for (const t of normTargets) score = Math.max(score, scoreMatch(t, norm));
    if (!best || score > best.score) best = { href: hit.href, score };
  }
  return best && best.score >= 0.62 ? best.href : null;
}

/** The multilink id in the title page (`mirrored.to/multilinks/<ID>`). */
async function multilinkIdFrom(seriesUrl: string): Promise<string | null> {
  const html =
    (await fetchText(seriesUrl, { headers: AZ_HEADERS, timeoutMs: 15000 })) ||
    (await fetchTextWithBypass(seriesUrl, { headers: AZ_HEADERS, timeoutMs: 15000 }));
  if (!html) return null;

  const m =
    html.match(/https?:\/\/(?:www\.)?mirrored\.to\/multilinks\/([A-Za-z0-9]+)/) ||
    html.match(/mirrored\.to\/(?:multilinks|embed)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

interface FileLink {
  fid: string;
  /** full absolute URL of the `_links` page */
  url: string;
  /** raw filename from the path */
  fname: string;
  episode: number;
}

/** Per-episode `/files/<FID>/<name>.mp4_links` entries from a multilink page. */
async function fileLinksFromMultilink(mlId: string, jar: SimpleJar): Promise<FileLink[]> {
  const html = await jarText(jar, `${MLB}/multilinks/${mlId}`, `${MLB}/`);
  if (!html) return [];

  const out: FileLink[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/(?:www\.)?mirrored\.to\/files\/([A-Za-z0-9]+)\/([^"'+\s<>]+?)_links/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const fid = m[1];
    const fname = decodeURIComponent(m[2]);
    const url = `${MLB}/files/${fid}/${encodeURIComponent(fname)}_links`;
    if (seen.has(url)) continue;
    seen.add(url);

    // Episode from `…_-_01_[Hakoniwa].mp4` fansub names.
    const em = fname.match(/[-_\s]0?(\d{1,4})(?:v\d+)?_\[/) || fname.match(/[-_\s]0?(\d{1,4})\.mp4/i);
    const episode = Number(em?.[1] ?? NaN);
    out.push({ fid, url, fname, episode });
  }
  return out;
}

/** A multilink page lists raw file ids only when it renders the rich table; the
 *  flat layout instead exposes bare `/files/<FID>?dl=0` shortcuts. Accept both. */
async function fileIdsFromMultilink(mlId: string, jar: SimpleJar): Promise<string[]> {
  const html = await jarText(jar, `${MLB}/multilinks/${mlId}`, `${MLB}/`);
  if (!html) return [];
  const out: string[] = [];
  const re = /mirrored\.to\/files\/([A-Za-z0-9]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * The host table from /mirstats.php. Mirrored's own doc names the endpoint:
 * `uid` = file id, `tmpID` = per-file session token from the ?dl=0 page,
 * `fn` = filename. Every visible host row links `/getlink/<uid>/<hostId>/`.
 */
interface MirroredHost {
  name: string;
  /** absolute getlink URL */
  url: string;
  streamable: boolean;
}

async function mirroredHosts(
  fid: string,
  tmpId: string,
  fname: string,
  jar: SimpleJar
): Promise<MirroredHost[]> {
  const params = new URLSearchParams({
    uid: fid,
    tmpID: tmpId,
    fn: fname,
    ads: '1',
    gp: '1',
    su: '0',
    pid: '0',
    puid: '0',
    fd: '1',
    s: '1',
    lang: 'en',
    ftype: 'Video',
    cn: 'US',
    m: '0',
  });

  const html =
    (await jarText(jar, `${MLB}/mirstats.php?${params.toString()}`, `${MLB}/files/${fid}/?hash=${tmpId}&dl=0`)) || '';
  if (!html) return [];

  const hosts: MirroredHost[] = [];
  const seen = new Set<string>();
  const $ = loadHtml(html);

  const rows = $('table tr');
  rows.each((_, tr) => {
    const row = $(tr);
    const img = row.find('img').first();
    const name = (img.attr('alt') || '').trim();
    const a = row.find(`a[href*="/getlink/${fid}/"]`).first();
    let link = (a.attr('href') || '').trim();
    if (!link && !name) return;
    if (link && !/^https?:\/\//.test(link)) link = `${MLB}${link.startsWith('/') ? '' : '/'}${link}`;
    if (!link || seen.has(link)) return;
    seen.add(link);

    const rowText = row.text().toLowerCase();
    const streamable = row.find('.streamable').first().length > 0 || /streamable/.test(rowText);
    hosts.push({ name: name || 'unknown', url: link, streamable });
  });

  // Fallback: regex the raw HTML in case the row shape changes.
  if (hosts.length === 0) {
    const rowRe = /<img[^>]+alt="([^"]+)"[^>]+src="[^"]*\/hosts\/[^"]+"[^>]/g;
    for (let m = rowRe.exec(html); m; m = rowRe.exec(html)) {
      const name = m[1].trim();
      if (name && !hosts.some((h) => h.name === name)) {
        hosts.push({ name, url: '', streamable: true });
      }
    }
  }

  return hosts;
}

/** The `data-clipboard-text` (or `<code>` body) on a /getlink page. */
async function directUrlFromGetlink(
  getlinkUrl: string,
  referer: string,
  jar: SimpleJar
): Promise<string | null> {
  const html = await jarText(jar, getlinkUrl, referer);
  if (!html) return null;

  const fromAttr = html.match(/data-clipboard-text="([^"]+)"/);
  const fromCode = html.match(/<code>([^<]+)<\/code>/);
  const url = (fromAttr?.[1] || fromCode?.[1] || '').trim();
  return url && /^https?:\/\//.test(url) ? url : null;
}

const provider: StreamProvider = {
  name: PROVIDER_NAME,
  sites: [BASE, MLB],

  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      const seriesHref = await resolveSeriesHref(opts);
      if (!seriesHref) return [];

      const mlId = await multilinkIdFrom(seriesHref);
      if (!mlId) return [];

      const jar = new SimpleJar();
      const episode = Number(opts.episode);
      const links = await fileLinksFromMultilink(mlId, jar);

      let fileLink: FileLink | undefined =
        episode > 0 && Number.isFinite(episode) ? links.find((l) => l.episode === episode) : undefined;
      if (!fileLink && links.length > 0) {
        // Unnumbered or mis-numbered names — fall back to positional order.
        if (Number.isFinite(episode) && episode > 0 && episode <= links.length) {
          fileLink = [...links].sort((a, b) => (a.episode || 0) - (b.episode || 0))[episode - 1];
        } else {
          fileLink = links[0];
        }
      }

      // Some multilinks expose only flat `/files/<FID>` rows; synthesize the
      // `_links` path so the episode-number selection above keeps working.
      if (!fileLink) {
        const ids = await fileIdsFromMultilink(mlId, jar);
        if (ids.length === 0) return [];
        const idx = Number.isFinite(episode) && episode > 0 ? Math.min(episode, ids.length) - 1 : 0;
        const fid = ids[idx] || ids[0];
        fileLink = { fid, url: `${MLB}/files/${fid}_links`, fname: '', episode };
      }

      // ── File links page: exact filename + ?hash=<tid>&dl=0 button ──────────
      const pageHtml = await jarText(jar, fileLink.url, `${MLB}/`);
      if (!pageHtml) return [];

      const fnameMatch = pageHtml.match(/<h3 class="hdark">([^<]+)<\/h3>/i);
      const fname = (fnameMatch?.[1] || fileLink.fname || '').trim();
      const hashMatch = pageHtml.match(
        /https?:\/\/(?:www\.)?mirrored\.to\/files\/[A-Za-z0-9]+\/?\?hash=([0-9a-f]{32})&dl=0/i,
      );
      if (!hashMatch) return [];
      const tid = hashMatch[1];

      // tmpID is a second per-file token, only stamped on the `?hash=…&dl=0`
      // page itself (the `_links` page never carries it). Fetch that page and
      // read it out of the inline `ajaxRequest.open("/mirstats.php?…tmpID=…")`.
      const dl0 = await jarText(jar, `${MLB}/files/${fileLink.fid}/?hash=${tid}&dl=0`, `${MLB}/files/${fileLink.fid}/`);
      const tmpId =
        dl0?.match(/tmpID=([0-9a-f]{32})/i)?.[1] ??
        dl0?.match(/"([0-9a-f]{32})"\s*;\s*var/)?.[1] ??
        tid;

      // ── mirstats: host table ──────────────────────────────────────────────
      const hosts = await mirroredHosts(fileLink.fid, tmpId, fname, jar);
      if (hosts.length === 0) return [];

      // ── getlink → host URL → direct resolution ────────────────────────────
      // Bound the chain: at most 4 streamable hosts in parallel.
      const streamable = hosts.filter((h) => h.streamable).slice(0, 4);
      const candidates = (streamable.length > 0 ? streamable : hosts.slice(0, 4)).filter((h) => h.url);

      const resolved = await Promise.all(
        candidates.map(async (host) => {
          try {
            const direct = await directUrlFromGetlink(host.url, `${MLB}/files/${fileLink.fid}/`, jar);
            if (!direct) return null;

            const outcome = await resolveToDirectOrEmbed(direct, `${MLB}/`);
            if (!outcome) return null;

            const result: SourceResult = {
              source: PROVIDER_NAME,
              url: outcome.url,
              quality: outcome.quality || (outcome.sourceType === 'custom' ? 'auto' : '1080p'),
              headers: {
                'User-Agent': UA,
                ...(outcome.headers || {}),
              },
              subtitles: [] as SubtitleTrack[],
              audioLanguage: 'es',
              language: 'Spanish (fansub hardsub)',
              sourceType: outcome.sourceType,
              server: host.name,
              providerName: PROVIDER_NAME,
            };
            return result;
          } catch {
            return null;
          }
        }),
      );

      return resolved.filter((r): r is SourceResult => Boolean(r));
    } catch {
      return [];
    }
  },

  getLanguages: async () => [{ language: 'es', label: 'Spanish (hardsub)', type: 'subtitle' }],
};

export default provider;
