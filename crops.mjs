// Вирізає з PDF фрагмент кожної позиції меблів.
//
// Чому саме з PDF, а не з готового зображення аркуша: у картці фрагмент показується
// на всю ширину, тобто аркуш «збільшується» в кілька разів. Растр 3200 px для цього
// замалий — розмірні числа розмиваються. PDF векторний, тож рендеримо потрібну
// ділянку одразу в тій роздільності, яка потрібна на екрані.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const PDF = 'E:\\Denys\\Проект Шевченка\\Креслення.pdf';
// Картка показує фрагмент завширшки ~334 px на телефоні і 330 px на компʼютері,
// тож 1200 покриває навіть екран із потрійною щільністю, а 600 — звичайний ноутбук.
const WIDTHS = [600, 1200];
const PAD = 0.015;               // трохи повітря навколо предмета
const Q = 86;

const catalog = fs.readFileSync(path.join(OUT, 'catalog.js'), 'utf8').replace(/^window\.CATALOG = /, '').replace(/;\s*$/, '');
const C = JSON.parse(catalog);

// унікальні фрагменти: кілька позицій в одній рамці ділять один файл
const crops = new Map();
for (const f of C.furniture) {
  if (!f.crop || !f.box || crops.has(f.crop)) continue;
  crops.set(f.crop, { sheet: f.sheet, box: f.box });
}

const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(PDF)), useSystemFonts: true, verbosity: 0 }).promise;
for (const w of WIDTHS) fs.mkdirSync(path.join(OUT, 'img', 'dwg', 'crop', 'w' + w), { recursive: true });

let total = 0;
for (const [id, { sheet, box }] of crops) {
  const x = Math.max(0, box.x - PAD), y = Math.max(0, box.y - PAD);
  const bw = Math.min(1 - x, box.w + 2 * PAD), bh = Math.min(1 - y, box.h + 2 * PAD);
  const page = await doc.getPage(sheet);
  const vp1 = page.getViewport({ scale: 1 });

  for (const target of WIDTHS) {
    const scale = target / (bw * vp1.width);
    const vp = page.getViewport({ scale });
    const cw = Math.round(bw * vp.width), chh = Math.round(bh * vp.height);
    const canvas = createCanvas(cw, chh);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, chh);
    // зсуваємо сторінку так, щоб потрібна ділянка потрапила в канву
    await page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: [1, 0, 0, 1, -Math.round(x * vp.width), -Math.round(y * vp.height)],
    }).promise;
    const r = await sharp(canvas.toBuffer('image/png')).webp({ quality: Q })
      .toFile(path.join(OUT, 'img', 'dwg', 'crop', 'w' + target, id + '.webp'));
    total += r.size;
    if (target === WIDTHS[WIDTHS.length - 1]) {
      console.log(`${id}: аркуш ${sheet}, ділянка ${(bw * 100).toFixed(0)}%×${(bh * 100).toFixed(0)}% → ${cw}×${chh}, ${Math.round(r.size / 1024)} КБ`);
    }
  }
  page.cleanup();
}
console.log(`\nфрагментів: ${crops.size}, файлів: ${crops.size * WIDTHS.length}, разом ${(total / 1048576).toFixed(1)} МБ`);
