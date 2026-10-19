import { fetchText, loadHtml } from '../src/utils/http/fetch.js';
import { normalizeTitle, scoreMatch } from '../src/utils/scraping/title-normalizer.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const html = await fetchText('https://az-animex.com/?s=naruto', { headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' }, timeoutMs: 15000 });
if (!html) { console.log('fail'); process.exit(0); }
const $ = loadHtml(html);
const pool: Array<{ href: string; alt: string }> = [];
$('li.wp-block-post').each((_, el) => {
  const href = $(el).find('a').first().attr('href') || '';
  const alt = ($(el).find('img').first().attr('alt') || '').trim();
  if (href) pool.push({ href, alt });
});
console.log('pool:', pool.length);
const targets = ['naruto', 'ntv'].map(normalizeTitle);
for (const p of pool) {
  const norm = normalizeTitle(p.alt);
  let best = 0;
  for (const t of targets) best = Math.max(best, scoreMatch(t, norm));
  console.log(best.toFixed(3), '|', norm.slice(0, 60), '|', p.href.slice(0, 80));
}
