import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
const types = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'layout.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8', 'favicon.svg': 'image/svg+xml' };
const assets = {};
for (const [file, type] of Object.entries(types)) assets[file === 'index.html' ? '/' : '/' + file] = { type, body: await readFile(new URL('../public/' + file, import.meta.url), 'utf8') };
await mkdir(new URL('../dist/server/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/server/assets.js', import.meta.url), `export default ${JSON.stringify(assets)};\n`);
await copyFile(new URL('../worker/index.js', import.meta.url), new URL('../dist/server/index.js', import.meta.url));
console.log('Built IMGE Worker with persistent R2 image storage.');
