import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../server.js';
import { splitTiles } from '../public/layout.js';

async function listen(directory, maxPhotos = 500) { const app = await createApp({ directory, maxPhotos }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); return { ...app, url: `http://127.0.0.1:${app.server.address().port}` }; }
test('equal-area layouts fill desktop/mobile walls with no overlaps', () => {
  for (const [width, height] of [[1200, 700], [360, 640]]) for (let n = 1; n <= 60; n++) {
    const rects = splitTiles(n, width, height); assert.equal(rects.length, n);
    for (const r of rects) { assert.ok(Math.abs(r.width * r.height - width * height / n) < 0.001); assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= width + 0.001 && r.y + r.height <= height + 0.001); }
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) { const x = rects[a], y = rects[b]; assert.ok(Math.min(x.x + x.width, y.x + y.width) - Math.max(x.x, y.x) < 0.001 || Math.min(x.y + x.height, y.y + y.height) - Math.max(x.y, y.y) < 0.001); }
  }
});
test('uploads synchronize, validate, persist and respect concurrent capacity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'imge-test-')); let app;
  try {
    app = await listen(directory, 3);
    const events = await fetch(app.url + '/api/events'), reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: \[\]/);
    const input = await sharp({ create: { width: 40, height: 60, channels: 3, background: '#d6fb72' } }).png().toBuffer();
    const upload = () => fetch(app.url + '/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: input });
    const first = await upload(); assert.equal(first.status, 201); const photo = await first.json();
    assert.match(new TextDecoder().decode((await reader.read()).value), new RegExp(photo.id)); await reader.cancel();
    const image = await fetch(app.url + photo.url); assert.equal(image.headers.get('content-type'), 'image/webp'); assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format, 'webp');
    assert.equal((await fetch(app.url + '/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'bad image' })).status, 422);
    assert.equal((await fetch(app.url + '/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' })).status, 415);
    assert.equal((await fetch(app.url + '/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/png', 'Sec-Fetch-Site': 'cross-site' }, body: input })).status, 403);
    const results = await Promise.all([upload(), upload(), upload()]); assert.deepEqual(results.map(r => r.status).sort(), [201, 201, 507]);
    assert.equal((await fetch(app.url + '/api/photos/' + photo.id, { method: 'DELETE' })).status, 401);
    assert.equal((await readdir(directory)).length, 3);
    await app.close(); app = await listen(directory, 3);
    const restored = await (await fetch(app.url + '/api/photos')).json(); assert.equal(restored.length, 3); assert.ok(restored.some(p => p.id === photo.id));
    assert.equal((await fetch(app.url + '/images/../../server.js')).status, 404);
  } finally { if (app) await app.close(); await rm(directory, { recursive: true, force: true }); }
});
