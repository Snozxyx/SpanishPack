/**
 * PelisForte — https://www2.pelisforte.se  (SPANISH/CASTELLANO LATINO)
 *
 * WordPress "ToroFilm" catalogue. Verified against the live site (140 kB episode
 * page):
 *
 *   - search    `?s=<query>` → wp post links into `/serie/<slug>` (`<slug>` carries
 *               a numeric suffix, e.g. `/serie/el-juego-del-calamar-1751082264`).
 *   - episode   URL shape `/episodio/<serieSlug>-<S>x<E>`; the season/episode pair
 *               comes from ani.zip (AniList absolute → TMDB S/E), and the localized
 *               Spanish title drives the search.
 *   - player    `aside.video-player` holds `div#options-N.video` player blocks,
 *               each containing a lazy `<iframe data-src="https://mp4.nu/?h=BASE64">`.
 *               `aside.video-options` holds the language tabs (`span[tab=ln0]` =
 *               "Español Latino", `ln1` = "Castellano", `ln2` = "Subtitulado"), whose
 *               `div#ln{K}` sections list the options as `a[href="#options-M"]`.
 *   - mp4.nu    `r.php?h=` packed JWPlayer → m3u8 file + captions (see mp4nu.ts).
 *
 * Results are emitted per language with `audioLanguage` set per the tab;
 * unresolved embeds stay as `custom` fallbacks so the app's webview can still
 * play them.
 */
import type { StreamProvider, SourceOptions, SourceResult, SubtitleTrack } from '../../types/index.js';
import { fetchText, loadHtml } from '../../utils/http/fetch.js';
import { fetchTextWithBypass } from '../../utils/common/fetch-bypass.js';
import { resolveTmdbTarget } from '../../utils/mapping/anizip.js';
import { normalizeTitle, scoreMatch } from '../../utils/scraping/title-normalizer.js';
import { resolveMp4Nu } from './mp4nu.js';

const BASE = 'https://www2.pelisforte.se';
const PROVIDER_NAME = 'pelisforte';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const SITE_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  'Accept-Language': 'es-419,es;q=0.9',
};

/** Tab label → BCP-47 audio language. */
function languageFromLabel(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('latino')) return 'es-419';
  if (l.includes('castellano')) return 'es';
  if (l.includes('sub') || l.includes('vo') || l.includes('japon')) return 'ja';
  return 'es-419';
}

/** Search the WP catalogue for the series page. */
async function findSerieSlug(titles: string[]): Promise<string | null> {
  const pool: Array<{ slug: string; label: string }> = [];
  const seen = new Set<string>();

  for (const title of titles.slice(0, 3)) {
    const html =
      (await fetchText(`${BASE}/?s=${encodeURIComponent(title)}`, {
        headers: SITE_HEADERS,
        timeoutMs: 15000,
      })) ||
      (await fetchTextWithBypass(`${BASE}/?s=${encodeURIComponent(title)}`, {
        headers: SITE_HEADERS,
        timeoutMs: 15000,
      }));
    if (!html) continue;
    const $ = loadHtml(html);

    const push = (href: string, label: string) => {
      const m = href.match(/\/serie\/([a-z0-9\-]+)/i);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      pool.push({ slug: m[1], label: label || m[1] });
    };

    $('a[href*="/serie/"]').each((_, el) => {
      push($(el).attr('href') || '', $(el).text().replace(/\s+/g, ' ').trim());
    });
    // This site also links post-types films/; keep those too — episode URLs
    // follow the same `-SxE` suffix whether the parent is serie or film.
    $('a[href*="/film/"], a[href*="/pelicula/"]').each((_, el) => {
      push($(el).attr('href') || '', $(el).text().replace(/\s+/g, ' ').trim());
    });
  }

  const normTargets = titles.map(normalizeTitle);
  for (const item of pool) {
    if (normTargets.some((t) => t === normalizeTitle(item.label))) return item.slug;
  }

  let best: { slug: string; score: number } | null = null;
  for (const item of pool) {
    let score = 0;
    for (const t of normTargets) score = Math.max(score, scoreMatch(t, normalizeTitle(item.label)));
    if (!best || score > best.score) best = { slug: item.slug, score };
  }
  return best && best.score >= 0.6 ? best.slug : null;
}

interface PfOption {
  /** player block id, e.g. "options-2" → 2 */
  optionIndex: number;
  languageLabel: string;
  poster: string | null;
  serverLabel: string;
}

interface PfPlayer {
  optionIndex: number;
  embedUrl: string;
}

/**
 * Parse one episode page into language→player-block mapping.
 *
 * The verified layout:
 *   <aside class="video-options">
 *     <span tab="ln0">Español Latino</span> …
 *     <div id="ln0" class="lrt"><ul class="aa-tbs aa-tbs-video" data-tbs="aa-options">
 *       <li><a class="btn on" href="#options-0">OPCIÓN 1 … <img/video title="Byse">
 *     </ul></div>
 *   <aside class="video-player">
 *     <div id="options-0" class="video aa-tb hdd"><iframe data-src="…mp4.nu?h=…">
 */
function parseEpisodePage(html: string): {
  options: PfOption[];
  players: PfPlayer[];
} {
  const $ = loadHtml(html);
  const options: PfOption[] = [];
  const players: PfPlayer[] = [];

  // language tab labels
  const tabLabels = new Map<string, string>();
  $('.video-options span[tab]').each((_, el) => {
    const tab = ($(el).attr('tab') || '').trim().toLowerCase(); // ln0…
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    if (tab && label) tabLabels.set(tab, label);
  });

  // options per language section
  $('.video-options div[id^="ln"]').each((_, el) => {
    const section = $(el);
    const lnId = (section.attr('id') || '').toLowerCase();
    if (!lnId) return;
    const languageLabel = tabLabels.get(lnId) || 'Destino';

    section.find(`a[href*="#options-"]`).each((__, a) => {
      const anchor = $(a);
      const href = anchor.attr('href') || '';
      const om = href.match(/#options-?(\d+)/i);
      if (!om) return;
      const serverLabel = anchor.find('img').attr('title') || anchor.find('img').attr('alt') || anchor.find('strong').text().trim() || anchor.text().replace(/\s+/g, ' ').trim();
      options.push({
        optionIndex: Number(om[1]),
        languageLabel,
        poster: anchor.find('img').attr('src') || null,
        serverLabel: (serverLabel || '').trim(),
      });
    });
  });

  // player blocks + their lazy iframes
  $('.video-player div[id^="options"]').each((_, el) => {
    const block = $(el);
    const id = (block.attr('id') || '').toLowerCase();
    const m = id.match(/options-?(\d+)/i);
    const iframe = block.find('iframe').first();
    let src = (iframe.attr('data-src') || iframe.attr('src') || '').trim();
    if (!src) return;
    if (!/^https?:\/\//.test(src)) src = src.startsWith('//') ? `https:${src}` : `https://${src}`;
    players.push({ optionIndex: m ? Number(m[1]) : -1, embedUrl: src });
  });

  // Some themes inline the iframe without the wrapping aside — accept any
  // aa-tb iframe as a player last.
  if (players.length === 0) {
    $('iframe[data-src*="mp4.nu"], iframe[src*="mp4.nu"], iframe[data-src*="h="]').each((_, el) => {
      let src = ($(el).attr('data-src') || $(el).attr('src') || '').trim();
      if (!src) return;
      if (!/^https?:\/\//.test(src)) src = src.startsWith('//') ? `https:${src}` : `https://${src}`;
      players.push({ optionIndex: -1, embedUrl: src });
    });
  }

  return { options, players };
}

const provider: StreamProvider = {
  name: PROVIDER_NAME,
  sites: [BASE],

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
      if (target.type !== 'tv' || target.season === undefined || target.episode === undefined) {
        // Movie/OVA types have no SxE route on this site pattern.
        if (target.type !== 'tv') return [];
      }
      const season = target.season ?? 1;
      const ep = target.episode ?? episode;

      const slug = await findSerieSlug(target.titles.length ? target.titles : opts.titles);
      if (!slug) return [];

      const episodeUrl = `${BASE}/episodio/${slug}-${season}x${ep}`;
      const html =
        (await fetchText(episodeUrl, { headers: SITE_HEADERS, timeoutMs: 15000 })) ||
        (await fetchTextWithBypass(episodeUrl, { headers: SITE_HEADERS, timeoutMs: 15000 }));
      if (!html) return [];

      const { options, players } = parseEpisodePage(html);
      if (options.length === 0) return [];

      const playerByIndex = new Map<number, PfPlayer>();
      players.forEach((p) => playerByIndex.set(p.optionIndex, p));

      // De-duplicate options per language — one option per (language, block).
      const out: SourceResult[] = [];
      const seen = new Set<string>();
      const langCount = new Map<string, number>();

      for (const option of options) {
        const player = playerByIndex.get(option.optionIndex) ?? players[0];
        if (!player) continue;

        const dedupeKey = `${option.languageLabel}:${option.optionIndex}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const langCountLocal = (langCount.get(option.languageLabel) || 0) + 1;
        langCount.set(option.languageLabel, langCountLocal);
        if (langCountLocal > 2) continue; // keep at most two per language

        const audioLanguage = languageFromLabel(option.languageLabel);
        const mp4nu = await resolveMp4Nu(player.embedUrl, `${BASE}/`);

        if (mp4nu?.url) {
          const subtitles: SubtitleTrack[] = (mp4nu.captions || []).slice(0, 6).map((c) => ({
            url: c.url,
            label: c.label || 'Subtítulo',
            language: 'es',
          }));
          out.push({
            source: PROVIDER_NAME,
            url: mp4nu.url,
            quality: mp4nu.quality || 'auto',
            headers: { 'User-Agent': UA, Referer: 'https://mp4.nu/' },
            subtitles,
            audioLanguage,
            language: option.languageLabel,
            sourceType: /\.m3u8/i.test(mp4nu.url) ? 'hls' : 'mp4',
            server: option.serverLabel || `mp4.nu ${option.languageLabel}`,
            providerName: PROVIDER_NAME,
          });
        }

        // Keep the raw embed as a webview-playable fallback (mirrors the
        // "direct + embed fallback" convention).
        out.push({
          source: PROVIDER_NAME,
          url: player.embedUrl,
          quality: 'auto',
          headers: { 'User-Agent': UA, Referer: `${BASE}/` },
          subtitles: [],
          audioLanguage,
          language: option.languageLabel,
          sourceType: 'custom',
          server: option.serverLabel || `embed ${option.languageLabel}`,
          providerName: PROVIDER_NAME,
        });
      }

      return out;
    } catch {
      return [];
    }
  },

  getLanguages: async () => [
    { language: 'es-419', label: 'Español Latino', type: 'audio' },
    { language: 'es', label: 'Castellano', type: 'audio' },
    { language: 'ja', label: 'Subtitulado', type: 'audio' },
  ],
};

export default provider;
