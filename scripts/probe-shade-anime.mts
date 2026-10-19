const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const BASE = 'https://www.shademanga.com';

const r1 = await fetch(`${BASE}/api/anime?q=naruto&page=1&pageSize=10`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
const list = await r1.json();
console.log('search status:', r1.status, 'rows:', Array.isArray(list?.items) ? list.items.length : JSON.stringify(list).slice(0, 200));
const items = list?.items || list || [];
for (const it of items.slice(0, 6)) console.log(' -', it.token, it.slug, '|', String(it.titulo).slice(0, 50));

if (items.length) {
  const tok = items[0].token;
  const r2 = await fetch(`${BASE}/api/anime/${tok}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const det = await r2.json();
  console.log('\ndetail:', r2.status, det?.titulo, '| eps:', det?.totalEpisodios, '| servers:', JSON.stringify(det?.servidores || det?.servers || det?.generos)?.slice(0, 200));

  const r3 = await fetch(`${BASE}/api/anime/${tok}/1`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const ep1 = await r3.json();
  console.log('\nep1 status:', r3.status, JSON.stringify(ep1).slice(0, 600));
}
