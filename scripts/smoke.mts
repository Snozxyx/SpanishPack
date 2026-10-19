import azanimex from '../src/providers/stream/azanimex.js';
import shademanga from '../src/providers/manga/shademanga.js';

async function main() {
  console.log('== azanimex single (titles+ep1) ==');
  const t0 = Date.now();
  const res = await azanimex.single({
    anilistId: 0,
    titles: ['Mushoku Tensei Iii Isekai Ittara Honki Dasu'],
    episode: 1,
    resolution: '1080p',
  });
  console.log('azanimex results:', res.length, 'in', Date.now() - t0, 'ms');
  for (const r of res.slice(0, 4)) {
    console.log(' -', r.server, r.sourceType, r.quality, String(r.url).slice(0, 110));
  }

  console.log('\n== shademanga chapters (Dandadan) ==');
  const t1 = Date.now();
  const chapters = await shademanga.getChapters({
    titles: ['Dandadan'],
  });
  console.log('shademanga chapters:', chapters.length, 'in', Date.now() - t1, 'ms');
  const first = chapters[0];
  if (first) {
    console.log(' first chapter:', first.number, first.sources[0].chapterKey, 'scan:', first.sources[0].scanlator);
    const pages = await shademanga.getPages(first.sources[0].chapterKey);
    console.log(' pages:', pages.length, pages[0]?.imageUrl?.slice(0, 100));
  }
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
