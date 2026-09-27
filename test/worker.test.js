import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import worker from '../dist/server/index.js';

test('hosted Worker stores images in bucket, rejects invalid uploads and limits requests', async () => {
  const objects = new Map();
  const bucket = {
    async put(key, value, options) { if (options?.onlyIf && objects.has(key)) return null; objects.set(key, { value, size: value.byteLength || 0 }); return { key }; },
    async list({ prefix }) { return { objects: [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, size: value.size })) }; },
    async get(key) { const found = objects.get(key); return found && { body: found.value, httpEtag: 'test' }; },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); }
  };
  const tasks = [], context = { waitUntil(task) { tasks.push(task); } }, env = { BUCKET: bucket };
  const call = (route, options) => worker.fetch(new Request('https://imge.test' + route, options), env, context);
  assert.equal((await call('/')).status, 200);
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).webp().toBuffer();
  const post = body => call('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/webp', Origin: 'https://imge.test', 'CF-Connecting-IP': '192.0.2.1' }, body });
  const uploaded = await post(bytes); assert.equal(uploaded.status, 201); const photo = await uploaded.json();
  assert.equal((await (await call('/api/photos')).json()).length, 1);
  const image = await call(photo.url); assert.equal(image.headers.get('Content-Type'), 'image/webp'); assert.equal((await image.arrayBuffer()).byteLength, bytes.length);
  assert.ok(objects.has('photos/' + photo.id));
  assert.equal((await post('not a webp')).status, 422);
  const denied = await call('/api/photos', { method: 'POST', headers: { Origin: 'https://attacker.test', 'Content-Type': 'image/webp' }, body: bytes }); assert.equal(denied.status, 403);
  assert.equal((await call('/api/photos/' + photo.id, { method: 'DELETE' })).status, 401);
  for (let i = 0; i < 8; i++) assert.equal((await post(bytes)).status, 201);
  assert.equal((await post(bytes)).status, 429);
  assert.equal((await call('/images/../../server.js')).status, 404);
  await Promise.all(tasks);
});
