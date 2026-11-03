// Copy the viewer (src/viewer.html) to the docs site as docs/viewer/index.html, opening Pip when no ?src is given.
//   node scripts/docs-viewer.mjs          write it
//   node scripts/docs-viewer.mjs --check  exit 1 if the docs copy is out of date (npm test runs this)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const src = new URL('../src/viewer.html', import.meta.url), out = new URL('../docs/viewer/index.html', import.meta.url);
const html = readFileSync(src, 'utf8').replace('<body>', '<body data-default="../assets/pip.glb">');
if (process.argv.includes('--check')) {
  if (!existsSync(out) || readFileSync(out, 'utf8') !== html) { console.error('docs/viewer/index.html is out of date: run npm run docs:viewer'); process.exit(1); }
  console.log('docs viewer up to date');
} else { writeFileSync(out, html); console.log('wrote docs/viewer/index.html'); }
