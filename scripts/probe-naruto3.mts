import { fetchText, loadHtml } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// 1. pagination: does ?s=naruto have a page 2 with the TV series?
for (const url of [
  'https://az-animex.com/?s=naruto&paged=2',
  'https://az-animex.com/page/2/?s=naruto',
]) {
  const html = await fetchText(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' }, timeoutMs: 15000 });
  if (!html) { console.log(url, '-> null'); continue; }
  const $ = loadHtml(html);
  const alts: string[] = [];
  $('li.wp-block-post img').each((_, el) => alts.push(($(el).attr('alt') || '').trim()));
  console.log(url, '->', alts.length, alts.slice(0, 4));
}

// 2. direct TV slugs
for (const slug of ['naruto', 'naruto-shippuuden', 'naruto-shippuden']) {
  const html = await fetchText(`https://www.az-animex.com/${slug}/`, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' }, timeoutMs: 15000 });
  if (!html || html.length < 5000) { console.log(slug, '->', html ? html.length : 'null'); continue; }
  const $ = loadHtml(html);
  const title = ($('h1').first().text() || '').replace(/\s+/g, ' ').slice(0, 80);
  const ml = html.match(/mirrored\.to\/multilinks\/([A-Za-z0-9]+)/);
  console.log(slug, '->', html.length, '| h1:', title, '| multilink:', ml ? ml[1] : null);
}
