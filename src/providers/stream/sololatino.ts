/**
 * SoloLatino — https://sololatino.net  (SPANISH LATINO / CASTELLANO / SUB)
 *
 * A Cloudflare-gated episode catalogue whose URL contract is known:
 *
 *   `/serie/<slug>/temporada-<S>/episodio-<E>`   (e.g. /serie/tokyo-revengers/temporada-4/episodio-1)
 *   `/serie/<slug>/temporada-<S>/`              (episode list, several per page)
 *
 * The player population pattern is the generic `iframe` OPCIONES layout, so
 * this provider searches with the WP `?s=` pattern, opens the season page, and
 * harvests every player iframe into the *generic* resolver
 * (`resolveToDirectOrEmbed`) — direct m3u8/mp4 when the chain resolves, and the
 * raw embed as a `custom` fallback otherwise.
 *
 * best-effort: unverified — this CI egress is 403-blocked at every hop
 * (5.6 kB challenge pages), so selectors below lean on the generic layout the
 * site shares with its Nuvio-port sibling (`player.pelisserieshoy.com` init),
 * updated to the known current player origin the toko port flagged as dead.
 * Runtime traffic rides fetchTextWithBypass, which solves CF via the bundled
 * browser runtime.
 */
import type { StreamProvider, SourceOptions, SourceResult, SubtitleTrack } from '../../types/index.js';
import { fetchText, loadHtml } from '../../utils/http/fetch.js';
import { fetchTextWithBypass } from '../../utils/common/fetch-bypass.js';
import { resolveTmdbTarget } from '../../utils/mapping/anizip.js';
import { normalizeTitle, scoreMatch } from '../../utils/scraping/title-normalizer.js';
import { resolveToDirectOrEmbed } from '../../utils/resolvers/index.js';

const BASE = 'https://sololatino.net';
const WWW_BASE = 'https://www.sololatino.net';
const PROVIDER_NAME = 'sololatino-spa';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const SITE_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  'Accept-Language': 'es-419,es;q=0.9',
};

async function fetchPage(url: string): Promise<string | null> {
  return (
    (await fetchText(url, { headers: SITE_HEADERS, timeoutMs: 15000 })) ||
    (await fetchTextWithBypass(url, { headers: SITE_HEADERS, timeoutMs: 15000 }))
  );
}

/** Find the serie slug with the WP search endpoint. */
async function findSerieSlug(titles: string[]): Promise<string | null> {
  const pool: Array<{ slug: string; label: string }> = [];
  const seen = new Set<string>();

  for (const title of titles.slice(0, 3)) {
    const html = await fetchPage(`${BASE}/?s=${encodeURIComponent(title)}`);
    if (!html) continue;
    const $ = loadHtml(html);

    $('a[href*="/serie/"], a[href*="/pelicula/"], a[href*="/anime/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/(?:serie|pelicula|anime)\/([a-z0-9\-]+)/i);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      pool.push({ slug: m[1], label: $(el).text().replace(/\s+/g, ' ').trim() || m[1] });
    });
  }

  const normTargets = titles.map(normalizeTitle);
  let best: { slug: string; score: number } | null = null;
  for (const item of pool) {
    const norm = normalizeTitle(item.label);
    if (normTargets.some((t) => t === norm)) return item.slug;
    let score = 0;
    for (const t of normTargets) score = Math.max(score, scoreMatch(t, norm));
    if (!best || score > best.score) best = { slug: item.slug, score };
  }
  return best && best.score >= 0.6 ? best.slug : null;
}

/** Player iframes from the episode page, best-first. */
async function harvestEmbeds(html: string): Promise<string[]> {
  const $ = loadHtml(html);
  const urls: string[] = [];
  const seen = new Set<string>();

  const push = (src: string) => {
    src = src.trim();
    if (!src) return;
    const abs = /^https?:\/\//.test(src) ? src : src.startsWith('//') ? `https:${src}` : `https://${src}`;
    if (seen.has(abs) || /googletagmanager|analytics|doubleclick|adservice/.test(abs)) return;
    seen.add(abs);
    urls.push(abs);
  };

  // Player containers first (OPCIONES blocks), then plain iframes.
  $('aside[class*="player"], .video-player, .player_options, div[id^="options"]').each((_, el) => {
    $(el).find('iframe[data-src], iframe[src], iframe[data-litespeed-src]').each((__, f) => {
      push(
        $(f).attr('data-src') || $(f).attr('data-litespeed-src') || $(f).attr('src') || ''
      );
    });
  });
  $('iframe[data-src], iframe[src], iframe[data-litespeed-src]').each((_, f) => {
    push($(f).attr('data-src') || $(f).attr('data-litespeed-src') || $(f).attr('src') || '');
  });

  return urls.slice(0, 6);
}

const provider: StreamProvider = {
  name: PROVIDER_NAME,
  sites: [BASE, WWW_BASE],

  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      const episode = Number(opts.episode);
      if (!Number.isFinite(episode) || episode <= 0) return [];

      const target = await resolveTmdbTarget({
        anilistId: opts.anilistId,
        episode,
        titles: opts.titles,
        language: 'es',
      });
      if (target.type !== 'tv') return [];
      const season = target.season ?? 1;
      const ep = target.episode ?? episode;

      const slug = await findSerieSlug(target.titles.length ? target.titles : opts.titles);
      if (!slug) return [];

      const episodeUrl = `${WWW_BASE}/serie/${slug}/temporada-${season}/episodio-${ep}`;
      const html = await fetchPage(episodeUrl);
      if (!html) return [];

      const embeds = await harvestEmbeds(html);
      if (embeds.length === 0) return [];

      const results: SourceResult[] = [];
      let serverIndex = 1;

      for (const embed of embeds) {
        const outcome = await resolveToDirectOrEmbed(embed, `${WWW_BASE}/`);
        if (!outcome) continue;

        const result: SourceResult = {
          source: PROVIDER_NAME,
          url: outcome.url,
          quality: outcome.sourceType === 'custom' ? 'auto' : outcome.quality || '1080p',
          headers: {
            'User-Agent': UA,
            ...(outcome.headers || {}),
          },
          subtitles: [] as SubtitleTrack[],
          audioLanguage: 'es-419',
          language: 'Latino',
          sourceType: outcome.sourceType,
          server: outcome.direct ? `Server ${serverIndex}` : `Embed ${serverIndex}`,
          providerName: PROVIDER_NAME,
        };
        serverIndex++;
        results.push(result);
        if (results.length >= 4) break;
      }

      return results;
    } catch {
      return [];
    }
  },

  getLanguages: async () => [
    { language: 'es-419', label: 'Latino', type: 'audio' },
    { language: 'es', label: 'Castellano', type: 'audio' },
    { language: 'ja', label: 'Subtitulado', type: 'audio' },
  ],
};

export default provider;
