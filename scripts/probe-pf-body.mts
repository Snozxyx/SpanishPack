import { fetchResponse } from '../src/utils/http/fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const res = await fetchResponse('https://www2.pelisforte.se/?s=naruto', {
  headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' },
  timeoutMs: 15000,
  redirect: 'follow',
});
const body = await res.text();
console.log('status:', res.status, 'len:', body.length);
console.log('has wp-block-post:', body.includes('wp-block-post'));
console.log('has /serie/:', (body.match(/\/serie\//g) || []).length);
console.log('has /episodio/:', (body.match(/\/episodio\//g) || []).length);
console.log('has Just a moment:', body.includes('Just a moment'));
console.log('has challenge:', body.includes('challenge'));
console.log('does Scheppend:' , body.includes('<div class="app-body">'));
const i = body.indexOf('/serie/');
if (i > 0) console.log('sample:', body.slice(i - 120, i + 160).replace(/\s+/g, ' '));
