import { fetchResponse } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const BASE = 'https://www2.pelisforte.se';

for (const path of ['/letter/N', '/series-1746289646/page/2', '/pelis/idiomas/espanol-latino']) {
  const res = await fetchResponse(`${BASE}${path}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' }, timeoutMs: 15000, redirect: 'follow' });
  const html = await res.text();
  const slugs = [...html.matchAll(/href="https:\/\/www2\.pelisforte\.se\/serie\/([a-z0-9\-]+)"/g)].map((m) => m[1]);
  const uniq = [...new Set(slugs)];
  console.log(`${res.status} ${path} -> ${uniq.length} serie links`);
  console.log(uniq.filter((s) => /naruto|boruto|calamar|one-piece|mushokus|kimetsu/.test(s)).slice(0, 8).join(', ') || uniq.slice(0, 6).join(', '));
}
