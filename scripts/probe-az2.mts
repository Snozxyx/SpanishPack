import { fetchText } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const html = await fetchText('https://www.az-animex.com/mushoku-tensei-iii-isekai-ittara-honki-dasu/', {
  headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' },
  timeoutMs: 15000,
});
if (html) {
  const hits = [...html.matchAll(/files\/[A-Z0-9]+\/[^"'`\s<>]+/g)].map((m) => m[0]);
  console.log('files hrefs:', hits.length);
  for (const h of hits.slice(0, 8)) console.log(' ', h);
}
