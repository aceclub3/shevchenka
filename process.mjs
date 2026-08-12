// Обробка проєкту Шевченка: оптимізація зображень + рендер PDF у зображення
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const SRC = 'E:\\Denys\\Проект Шевченка';
const OUT = path.dirname(fileURLToPath(import.meta.url));

const WEB_MAX = 2400, WEB_Q = 82;
const THUMB_MAX = 700, THUMB_Q = 75;
const DWG_MAX = 3200, DWG_Q = 85;

const sections = [
  { key: 'f1', dir: 'візуалізації 1 поверх', title: 'Візуалізації — 1 поверх' },
  { key: 'f2', dir: 'візуалізації 2 поверх', title: 'Візуалізації — 2 поверх' },
];

function naturalSort(a, b) {
  const na = parseFloat(a), nb = parseFloat(b);
  const ka = isNaN(na) ? Infinity : na, kb = isNaN(nb) ? Infinity : nb;
  if (ka !== kb) return ka - kb;
  return a.localeCompare(b, 'uk');
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

fs.mkdirSync(OUT, { recursive: true });
const manifest = { sections: [] };

// --- Зображення ---
for (const sec of sections) {
  const srcDir = path.join(SRC, sec.dir);
  const files = fs.readdirSync(srcDir).filter(f => /\.(jpe?g|png|webp)$/i.test(f)).sort(naturalSort);
  const webDir = path.join(OUT, 'img', sec.key);
  const thumbDir = path.join(webDir, 't');
  fs.mkdirSync(thumbDir, { recursive: true });

  const items = await mapLimit(files, 4, async (f, idx) => {
    const id = String(idx + 1).padStart(3, '0');
    const input = path.join(srcDir, f);
    const img = sharp(input, { limitInputPixels: 1e9 }).rotate();
    const web = await img.clone()
      .resize({ width: WEB_MAX, height: WEB_MAX, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEB_Q })
      .toFile(path.join(webDir, id + '.webp'));
    await img.clone()
      .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMB_Q })
      .toFile(path.join(thumbDir, id + '.webp'));
    console.log(`${sec.key} ${idx + 1}/${files.length}  ${f}  -> ${web.width}x${web.height} ${(web.size / 1024).toFixed(0)}KB`);
    return { src: `img/${sec.key}/${id}.webp`, thumb: `img/${sec.key}/t/${id}.webp`, w: web.width, h: web.height, orig: f };
  });
  manifest.sections.push({ key: sec.key, title: sec.title, items });
}

// --- OG-зображення (перший ландшафтний рендер 1-го поверху) ---
const f1 = manifest.sections[0].items;
const hero = f1.find(i => i.w > i.h) || f1[0];
await sharp(path.join(SRC, sections[0].dir, hero.orig), { limitInputPixels: 1e9 })
  .rotate()
  .resize({ width: 1200, height: 630, fit: 'cover' })
  .jpeg({ quality: 80 })
  .toFile(path.join(OUT, 'og.jpg'));
manifest.hero = { src: hero.src, w: hero.w, h: hero.h };
console.log('OG image from', hero.orig);

// --- PDF «Креслення» ---
const pdfPath = path.join(SRC, 'Креслення.pdf');
const data = new Uint8Array(fs.readFileSync(pdfPath));
const doc = await getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
console.log('PDF pages:', doc.numPages);
const dwgDir = path.join(OUT, 'img', 'dwg');
const dwgThumbDir = path.join(dwgDir, 't');
fs.mkdirSync(dwgThumbDir, { recursive: true });

const dwgItems = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = DWG_MAX / Math.max(vp1.width, vp1.height);
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const png = canvas.toBuffer('image/png');
  const id = 'p' + String(p).padStart(2, '0');
  const web = await sharp(png).webp({ quality: DWG_Q }).toFile(path.join(dwgDir, id + '.webp'));
  await sharp(png)
    .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside' })
    .webp({ quality: THUMB_Q })
    .toFile(path.join(dwgThumbDir, id + '.webp'));
  dwgItems.push({ src: `img/dwg/${id}.webp`, thumb: `img/dwg/t/${id}.webp`, w: web.width, h: web.height });
  console.log(`dwg ${p}/${doc.numPages} -> ${web.width}x${web.height} ${(web.size / 1024).toFixed(0)}KB`);
  page.cleanup();
}
manifest.sections.push({ key: 'dwg', title: 'Креслення', items: dwgItems });

// --- Копія оригінального PDF ---
fs.mkdirSync(path.join(OUT, 'files'), { recursive: true });
fs.copyFileSync(pdfPath, path.join(OUT, 'files', 'kreslennya.pdf'));
manifest.pdf = { href: 'files/kreslennya.pdf', mb: (fs.statSync(pdfPath).size / 1048576).toFixed(0) };

fs.writeFileSync(path.join(OUT, 'data.js'), 'window.GALLERY_DATA = ' + JSON.stringify(manifest) + ';\n');
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));

// Підсумок розміру
let total = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const fp = path.join(d, e.name); if (e.isDirectory()) walk(fp); else total += fs.statSync(fp).size; } })(OUT);
console.log(`SITE TOTAL: ${(total / 1048576).toFixed(1)} MB`);
console.log('DONE');
