import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Export the same artwork at browser icon sizes; no image service is needed.
const source =
  process.argv[2] ??
  fileURLToPath(new URL('../docs/assets/brand-icon-source.png', import.meta.url));
const sourceUrl = `data:image/png;base64,${(await readFile(source)).toString('base64')}`;
const destinations = [
  new URL('../public/', import.meta.url),
  new URL('../site-root/', import.meta.url),
];
for (const directory of destinations) await mkdir(directory, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const variants = await page.evaluate(async (url) => {
    const artwork = new Image();
    artwork.src = url;
    await artwork.decode();
    const output = {};
    for (const size of [16, 32, 48, 96, 180, 256]) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(artwork, 0, 0, size, size);
      output[size] = canvas.toDataURL('image/png').split(',')[1];
    }
    return output;
  }, sourceUrl);
  const png = Object.fromEntries(
    Object.entries(variants).map(([size, bytes]) => [size, Buffer.from(bytes, 'base64')]),
  );
  for (const [name, size] of Object.entries({
    'brand-icon.png': 256,
    'favicon.png': 96,
    'favicon-32.png': 32,
    'apple-touch-icon.png': 180,
  })) {
    for (const directory of destinations) await writeFile(new URL(name, directory), png[size]);
  }
  // Modern ICO files can embed PNG frames, retaining transparent edges.
  const sizes = [16, 32, 48];
  const directory = Buffer.alloc(6 + 16 * sizes.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png[size].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png[size].length;
  }
  const ico = Buffer.concat([directory, ...sizes.map((size) => png[size])]);
  for (const destination of destinations) await writeFile(new URL('favicon.ico', destination), ico);
  console.log('Exported brand icon, PNG favicons, Apple touch icon and ICO.');
} finally {
  await browser.close();
}
