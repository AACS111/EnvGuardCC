// Keep the shared brand artwork and generate matching desktop app icons.
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectRoot, tauriCli, run } from './tauri-tools.mjs';

const temporary = await mkdtemp(path.join(tmpdir(), 'envguardcc-icon-'));
try {
  const artwork = await readFile(path.join(projectRoot, 'public/envguardcc-icon.png'));
  // The app tile occupies about 80% of its canvas, leaving transparent margins.
  const source = path.join(temporary, 'desktop.svg');
  await writeFile(source, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="184"/></clipPath></defs>
  <image x="100" y="100" width="824" height="824" clip-path="url(#tile)" xlink:href="data:image/png;base64,${artwork.toString('base64')}"/>
</svg>`);
  await run(process.execPath, [tauriCli(), 'icon', source, '--output', path.join(temporary, 'icons')]);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngDirectory = path.join(temporary, 'png');
  await run(process.execPath, [tauriCli(), 'icon', source, '--output', pngDirectory, ...sizes.flatMap(size => ['--png', String(size)])]);
  const layers = await Promise.all(sizes.map(size => readFile(path.join(pngDirectory, `${size}x${size}.png`))));
  // ICO supports PNG layers directly; keep all seven sizes for Windows scaling.
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let index = 0; index < sizes.length; index++) {
    const entry = 6 + 16 * index;
    header[entry] = header[entry + 1] = sizes[index] % 256;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(layers[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += layers[index].length;
  }
  await writeFile(path.join(projectRoot, 'desktop/envguardcc.ico'), Buffer.concat([header, ...layers]));
  await copyFile(path.join(temporary, 'icons/icon.icns'), path.join(projectRoot, 'desktop/envguardcc.icns'));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
