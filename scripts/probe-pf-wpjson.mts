import { fetchResponse } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

async function show(url: string) {
  try {
    const res = await fetchResponse(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeoutMs: 15000, redirect: 'follow' });
    const body = await res.text();
    console.log(res.status, url.slice(0, 90), 'len', body.length);
    console.log(body.slice(0, 400).replace(/\s+/g, ' '));
    console.log('---');
  } catch (e: any) {
    console.log('ERR', url.slice(0, 90), e?.message || e);
  }
}

await show('https://www2.pelisforte.se/wp-json/wp/v2/search?search=naruto&per_page=20');
await show('https://www2.pelisforte.se/wp-json/wp/v2/search?search=calamar&per_page=10');
