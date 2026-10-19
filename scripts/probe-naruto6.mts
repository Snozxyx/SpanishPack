import pelisforte from '../src/providers/stream/pelisforte.js';
import { fetchText } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

console.log('== pelisforte search pages ==');
for (const q of ['naruto', 'naruto-shippuuden']) {
  const html = await fetchText(`https://www2.pelisforte.se/?s=${q}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' },
    timeoutMs: 15000,
  });
  if (!html) { console.log(q, '-> null'); continue; }
  const slugs = [...html.matchAll(/href="https?:\/\/[^"]*\/(serie|film|pelicula)\/([a-z0-9\-]+)/gi)].map((m) => m[2]);
  console.log(`${q} ->`, [...new Set(slugs)].slice(0, 6));
}

console.log('\n== pelisforte.single: Naruto (AniList 20, ep 1) ==');
const t0 = Date.now();
const r = await pelisforte.single({ anilistId: 20, titles: ['Naruto'], episode: 1, resolution: '1080p' } as any);
console.log('results:', r.length, 'in', Date.now() - t0, 'ms');
for (const x of r.slice(0, 5)) console.log(' -', x.server, x.audioLanguage, x.sourceType, String(x.url).slice(0, 90));

console.log('\n== direct episode page probe ==');
for (const slug of ['naruto', 'naruto-shippuuden', 'naruto-shippuden']) {
  const ep = await fetchText(`https://www2.pelisforte.se/episodio/${slug}-1x1`, { headers: { 'User-Agent': UA }, timeoutMs: 15000 });
  console.log(`${slug}-1x1 ->`, ep ? ep.length + ' bytes' : 'null', ep && /video-player|mp4\.nu/.test(ep) ? 'HAS PLAYER' : 'no player');
}
