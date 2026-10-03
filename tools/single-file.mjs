/**
 * Bundle the built web app into ONE self-contained .html file.
 * Useful for static hosts that only accept a single file (and for offline use).
 *   node tools/single-file.mjs apps/speaker-web/dist dist-single/sync-music.html
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'apps/speaker-web/dist';
const out = process.argv[3] ?? 'dist-single/sync-music.html';

let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

html = html.replace(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g, (_m, src) => {
  const js = fs.readFileSync(path.join(dir, src.replace(/^\//, '')), 'utf8');
  return `<script type="module">\n${js}\n</script>`;
});
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_m, href) => {
  const css = fs.readFileSync(path.join(dir, href.replace(/^\//, '')), 'utf8');
  return `<style>\n${css}\n</style>`;
});
// drop things that need sibling files
html = html.replace(/<link[^>]*rel="manifest"[^>]*>/g, '');
html = html.replace(/<link[^>]*rel="icon"[^>]*>/g, '');
html = html.replace(/navigator\.serviceWorker\.register\([^)]*\)/g, 'Promise.resolve()');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${out} — ${(html.length / 1024).toFixed(0)} kB, self-contained`);
