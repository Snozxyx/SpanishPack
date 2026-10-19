import { fetchResponse } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const res = await fetchResponse('https://www2.pelisforte.se/?s=naruto', {
  headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' },
  timeoutMs: 15000,
  redirect: 'follow',
});
const body = await res.text();
console.log(body.slice(0, 1500));
console.log('---TAIL---');
console.log(body.slice(-600));
