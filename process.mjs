// Збірка сайту «Проєкт Шевченка»: адаптивні зображення + рендер PDF креслень.
//
// Ключове про якість: мініатюри ріжуться по ШИРИНІ, а не по довгій стороні.
// Сітка розкладає плитки саме за шириною, тож портретне фото, обрізане до 700 px
// по висоті, давало всього 462 px ширини — і на екрані з DPR 3 розтягувалось утричі.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const SRC = 'E:\\Denys\\Проект Шевченка';
const OUT = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(OUT, 'img');

// Ширини для сітки. Найбільша (900) покриває телефон із DPR 3 у дві колонки
// та планшет із DPR 2 у три; далі браузер сам обирає найдешевший придатний файл.
const GRID_WIDTHS = [300, 450, 600, 900];
const GRID_Q = 78;
const FULL_MAX = 3000;      // для перегляду по кліку
const FULL_Q = 82;
const DWG_MAX = 3200;       // креслення: дрібні розміри мають лишатись читабельними
const DWG_Q = 85;

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
  const out = new Array(items.length);
  let i = 0;
  async function worker() { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Готує повний файл + усі ширини для сітки. Повертає метадані одного зображення.
async function emit(pipelineFactory, dirKey, id, fullMax, fullQ) {
  const full = await pipelineFactory()
    .resize({ width: fullMax, height: fullMax, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: fullQ })
    .toFile(path.join(IMG, dirKey, 'full', id + '.webp'));

  const variants = [];
  for (const w of GRID_WIDTHS) {
    if (w > full.width) break;              // не збільшуємо понад наявне
    const r = await pipelineFactory()
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: GRID_Q })
      .toFile(path.join(IMG, dirKey, 'w' + w, id + '.webp'));
    variants.push(r.width);
  }
  if (!variants.length) variants.push(full.width);
  return { id, w: full.width, h: full.height, grid: variants };
}

// Чистимо картинки, щоб не лишалось файлів від попередньої структури
if (fs.existsSync(IMG)) fs.rmSync(IMG, { recursive: true, force: true });
const manifest = { gridWidths: GRID_WIDTHS, sections: [] };

for (const sec of sections) {
  const srcDir = path.join(SRC, sec.dir);
  const files = fs.readdirSync(srcDir).filter(f => /\.(jpe?g|png|webp)$/i.test(f)).sort(naturalSort);
  for (const sub of ['full', ...GRID_WIDTHS.map(w => 'w' + w)]) {
    fs.mkdirSync(path.join(IMG, sec.key, sub), { recursive: true });
  }

  const items = await mapLimit(files, 4, async (f, idx) => {
    const id = String(idx + 1).padStart(3, '0');
    const input = path.join(srcDir, f);
    const meta = await emit(() => sharp(input, { limitInputPixels: 1e9 }).rotate(), sec.key, id, FULL_MAX, FULL_Q);
    console.log(`${sec.key} ${idx + 1}/${files.length}  ${f}  → ${meta.w}×${meta.h}, сітка: ${meta.grid.join('/')}`);
    return { ...meta, orig: f };
  });
  manifest.sections.push({ key: sec.key, title: sec.title, items });
}

// Шапка й OG-прев'ю. Окремий файл для шапки потрібен, бо вона розтягнута на всю
// ширину екрана: найбільший розмір із сітки (900 px) для неї замалий, а повний
// файл на 3000 px — це 0,5 МБ на першому ж екрані.
const f1 = manifest.sections[0].items;
const hero = f1.find(i => i.w > i.h) || f1[0];
const heroSrc = path.join(SRC, sections[0].dir, hero.orig);
const HERO_W = 1800;
const heroFile = await sharp(heroSrc, { limitInputPixels: 1e9 })
  .rotate().resize({ width: HERO_W, withoutEnlargement: true }).webp({ quality: 80 })
  .toFile(path.join(IMG, 'hero.webp'));
await sharp(heroSrc, { limitInputPixels: 1e9 })
  .rotate().resize({ width: 1200, height: 630, fit: 'cover' }).jpeg({ quality: 80 })
  .toFile(path.join(OUT, 'og.jpg'));
manifest.hero = { key: 'f1', id: hero.id, w: hero.w, h: hero.h, big: 'img/hero.webp', bigW: heroFile.width };
console.log(`шапка ${heroFile.width}px (${Math.round(heroFile.size / 1024)} КБ) і OG — з ${hero.orig}`);

// Креслення: кожна сторінка PDF → зображення
const pdfPath = path.join(SRC, 'Креслення.pdf');
const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: true, verbosity: 0 }).promise;
for (const sub of ['full', ...GRID_WIDTHS.map(w => 'w' + w)]) {
  fs.mkdirSync(path.join(IMG, 'dwg', sub), { recursive: true });
}
const dwgItems = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: DWG_MAX / Math.max(vp1.width, vp1.height) });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const png = canvas.toBuffer('image/png');
  const id = 'p' + String(p).padStart(2, '0');
  const meta = await emit(() => sharp(png), 'dwg', id, DWG_MAX, DWG_Q);
  // назва аркуша зі штампу в текстовому шарі PDF
  const tc = await page.getTextContent();
  const stamp = tc.items
    .filter(i => i.str.trim() && i.transform[5] < vp1.height * 0.08)
    .map(i => i.str.trim()).join(' ');
  dwgItems.push({ ...meta, page: p, stamp });
  console.log(`креслення ${p}/${doc.numPages} → ${meta.w}×${meta.h}`);
  page.cleanup();
}
manifest.sections.push({ key: 'dwg', title: 'Креслення', items: dwgItems });

fs.mkdirSync(path.join(OUT, 'files'), { recursive: true });
fs.copyFileSync(pdfPath, path.join(OUT, 'files', 'kreslennya.pdf'));
manifest.pdf = { href: 'files/kreslennya.pdf', mb: (fs.statSync(pdfPath).size / 1048576).toFixed(0) };

fs.writeFileSync(path.join(OUT, 'data.js'), 'window.GALLERY_DATA = ' + JSON.stringify(manifest) + ';\n');
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));

const SKIP = new Set(['node_modules', '.git']);
let total = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; const fp = path.join(d, e.name); if (e.isDirectory()) walk(fp); else total += fs.statSync(fp).size; } })(OUT);
console.log(`SITE TOTAL: ${(total / 1048576).toFixed(1)} MB (ліміт GitHub Pages — 1024 MB)`);
console.log('DONE');
