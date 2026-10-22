// Builds dist/mouse-racer.html: one self-contained file (practice mode with bots),
// with every script bundled and every image inlined. Run: node tools/build-single.mjs
// Options: --cars N  start practice with N cars (overrides the saved setting)
//          --out F   output file (default dist/mouse-racer.html)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const esbuild = process.env.ESBUILD || 'esbuild';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const cars = Number(arg('--cars')) || 0;
const outFile = path.resolve(ROOT, arg('--out') || 'dist/mouse-racer.html');

const js = execFileSync(esbuild, [path.join(PUB, 'game.js'), '--bundle', '--format=iife', '--minify', '--target=es2020'], { encoding: 'utf8', maxBuffer: 1 << 26 });

const assets = {};
for (const dir of ['cars', 'track']) {
  for (const f of fs.readdirSync(path.join(PUB, dir)).filter((f) => f.endsWith('.png'))) {
    assets[`${dir}/${f}`] = 'data:image/png;base64,' + fs.readFileSync(path.join(PUB, dir, f)).toString('base64');
  }
}

let html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
html = html.replace(/src="\.\/(cars\/[\w-]+\.png)"/g, (m, p) => `src="${assets[p]}"`);
html = html.replace(/<script type="module" src="\.\/game\.js"><\/script>/,
  () => `<script>window.MR_OFFLINE = true;${cars ? ` window.MR_FIELD = ${cars};` : ''} window.MR_ASSETS = ${JSON.stringify(assets)};</script>\n<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`);
if (!/^<!doctype/i.test(html)) html = '<!doctype html>\n<meta charset="utf-8">\n' + html;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(path.relative(ROOT, outFile), (html.length / 1024).toFixed(0), 'KB');
