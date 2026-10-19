/**
 * mp4.nu packer-based player (PelisForte's file host).
 *
 * `https://mp4.nu/?h=<base64>` wrappers funnel to `https://mp4.nu/r.php?h=<b64>`,
 * which serves a Dean-Edwards packed JWPlayer config. Verified tokens in the
 * packed dictionary: `hls2|master|m3u8|urlset|file|sources|captions|okhd|vplayer`.
 * After `unpack()` the config is plain JS, so the direct stream URL and any
 * caption files can be regexed as usual.
 */

import { fetchResponse } from '../../utils/http/fetch.js';
import { unpack } from '../../utils/resolvers/unpack.js';

const MP4NU = 'https://mp4.nu';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

/** Unwrap a `?h=` style embed to the `r.php` player page URL. */
function playerUrl(embedUrl: string): string {
  try {
    const u = new URL(embedUrl);
    const h = u.searchParams.get('h') || u.searchParams.get('kode') || u.searchParams.get('id');
    if (h) return `${MP4NU}/r.php?h=${encodeURIComponent(h)}`;
  } catch {
    /* malformed url */
  }
  return embedUrl;
}

interface PackedPlayerResult {
  url: string | null;
  quality: string | null;
  captions: Array<{ url: string; label: string }>;
}

function extractFromUnpacked(js: string): PackedPlayerResult {
  const out: PackedPlayerResult = { url: null, quality: null, captions: [] };

  // sources / file entries — strict first so ad-litter URLs don't win.
  const fileMatch =
    js.match(/file\s*:\s*["']https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*/i) ||
    js.match(/sources\s*:\s*\[\s*{[^}]*?file\s*:\s*["']https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*/i) ||
    js.match(/https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s>]*/i);
  const url = (fileMatch?.[0] || '').replace(/^(file\s*:\s*["']|sources.*?file\s*:\s*["'])/i, '')
    .replace(/["']$/, '');
  if (/^https?:\/\//.test(url)) out.url = url;

  const qMatch = js.match(/(?:label|quality)\s*:\s*["'](\d{3,4}p)["']/i);
  if (qMatch) out.quality = qMatch[1].toLowerCase();

  const capRe = /(?:\.srt|\.vtt)["']?\s*;\s*(?:label|language)\s*:\s*["']([^"']+)["']|captions?\s*:\s*\[\s*{[^}]*?(?:label|language)\s*:\s*["']([^"']+)["']/gi;
  for (let m = capRe.exec(js); m; m = capRe.exec(js)) {
    const label = (m[1] || m[2] || '').trim();
    if (!label) break;
    // The caption URL sits just before the label segment on the same literal.
    const urlMatch = js.slice(Math.max(0, m.index - 300), m.index + m[0].length)
      .match(/https?:\/\/[^"'\s]+\.srt[^"'\s]*|https?:\/\/[^"'\s]+\.vtt[^"'\s]*/i);
    if (urlMatch) out.captions.push({ url: urlMatch[0], label });
  }

  return out;
}

/**
 * Resolve an mp4.nu embed (or direct r.php player URL) to its direct stream
 * plus any caption tracks. Returns null when the host never answers.
 */
export async function resolveMp4Nu(
  embedUrl: string,
  referer: string
): Promise<PackedPlayerResult | null> {
  try {
    const res = await fetchResponse(playerUrl(embedUrl), {
      headers: {
        'User-Agent': DEFAULT_UA,
        Referer: referer,
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeoutMs: 15000,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!html) return null;

    return extractFromUnpacked(html.includes('p,a,c,k,e,d') ? unpack(html) : html);
  } catch {
    return null;
  }
}
