import { YoutubeTranscript } from 'youtube-transcript';

const idOrUrl = process.argv[2] || 'iG9CE55wbtY';
const lang    = process.argv[3]; // e.g. en | fr | auto

const opts = lang ? { lang } : undefined;

try {
  const items = await YoutubeTranscript.fetchTranscript(idOrUrl, opts);
  console.log('pkg: youtube-transcript');
  console.log('id/url:', idOrUrl, 'lang:', lang || '(default)');
  console.log('items:', items.length);
  console.log(items.slice(0, 3));
} catch (e) {
  console.error('ERROR:', e?.message || e);
}
