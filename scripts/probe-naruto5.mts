import { fetchText } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const html = await fetchText('https://www.az-animex.com/naruto/', { headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' }, timeoutMs: 15000 });
if (!html) process.exit(0);

// Extract EVERY unique internal link that mentions naruto/boruto/shippuuden
const set = new Map<string, string>();
for (const m of html.matchAll(/https?:\/\/www\.az-animex\.com\/([^"'#\s<>]+)/g)) {
  const path = m[1].replace(/\/$/, '');
  const dec = decodeURIComponent(path);
  if (/naruto|boruto|shippuuden|shippuden/i.test(dec) && dec !== 'naruto') set.set(path, dec);
}
for (const [path, dec] of set) console.log(path.slice(0, 90), '|', dec.slice(0, 90));
console.log('total:', set.size);
