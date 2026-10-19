import { fetchText, loadHtml } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

for (const q of ['naruto', 'naruto-shippuuden', 'boruto', 'one%20piece', 'mushoku']) {
  const html = await fetchText(`https://az-animex.com/?s=${q}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' },
    timeoutMs: 15000,
  });
  if (!html) { console.log(q, '-> null'); continue; }
  const $ = loadHtml(html);
  const alts: string[] = [];
  $('li.wp-block-post img').each((_, el) => { const a = ($(el).attr('alt') || '').trim(); if (a) alts.push(a); });
  console.log(q, '->', alts.length, JSON.stringify(alts.slice(0, 4)));
}
