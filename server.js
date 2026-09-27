import http from 'node:http';
import { mkdir, readdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.dirname(fileURLToPath(import.meta.url));
export async function createApp(options = {}) {
  const directory = options.directory || process.env.DATA_DIR || path.join(root, 'data');
  const maxPhotos = options.maxPhotos ?? Number(process.env.MAX_PHOTOS || 500);
  const maxBytes = 8 * 1024 * 1024;
  const quota = Number(process.env.STORAGE_LIMIT_MB || 512) * 1024 * 1024;
  const adminToken = process.env.ADMIN_TOKEN;
  await mkdir(directory, { recursive: true });
  let photos = (await readdir(directory)).filter(n => /^\d+-[\da-f-]{36}\.webp$/.test(n)).sort().map(id => ({ id, url: `/images/${id}` }));
  let usedBytes = (await Promise.all(photos.map(p => stat(path.join(directory, p.id))))).reduce((s, f) => s + f.size, 0);
  let activeUploads = 0;
  let queue = Promise.resolve();
  const clients = new Set(), limits = new Map();
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const broadcast = () => { for (const res of clients) { if (!res.write(`data: ${JSON.stringify(photos)}\n\n`)) res.destroy(); } };
  const serialize = async fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': heartbeat\n\n'); const now = Date.now(); for (const [key, value] of limits) if (now - value.start > 60000) limits.delete(key); }, 20000);
  heartbeat.unref();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/api/photos') return json(res, 200, photos);
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (clients.size >= 1000) return json(res, 503, { error: 'الخادم مشغول، حاول لاحقًا.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 3000\ndata: ${JSON.stringify(photos)}\n\n`);
        clients.add(res); res.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/photos') {
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'طلب غير مسموح.' });
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(req.headers['content-type'])) return json(res, 415, { error: 'اختر صورة JPG أو PNG أو WebP أو GIF أو AVIF.' });
        const ip = req.socket.remoteAddress;
        const now = Date.now(), bucket = limits.get(ip);
        if (bucket && now - bucket.start < 60000 && bucket.count >= 10) return json(res, 429, { error: 'وصلت للحد المؤقت. انتظر دقيقة ثم حاول مجددًا.' });
        limits.set(ip, !bucket || now - bucket.start >= 60000 ? { start: now, count: 1 } : { ...bucket, count: bucket.count + 1 });
        if (activeUploads >= 3) return json(res, 503, { error: 'تتم معالجة صور أخرى. حاول بعد قليل.' });
        if (Number(req.headers['content-length']) > maxBytes) return json(res, 413, { error: 'حجم الصورة الأقصى 8 ميغابايت.' });
        activeUploads++;
        try {
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > maxBytes) { json(res, 413, { error: 'حجم الصورة الأقصى 8 ميغابايت.' }); return; } chunks.push(chunk); }
          let compressed;
          try {
            const input = Buffer.concat(chunks);
            const image = sharp(input, { limitInputPixels: 24000000, animated: false });
            const meta = await image.metadata();
            if (!['jpeg', 'png', 'webp', 'avif', 'heif', 'gif'].includes(meta.format)) throw Error('format');
            compressed = await image.rotate().resize(1920, 1920, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 76, effort: 3 }).toBuffer();
          } catch { return json(res, 422, { error: 'تعذّر قراءة الصورة. جرّب صورة أخرى أصغر من 24 مليون بكسل.' }); }
          const photo = await serialize(async () => {
            if (photos.length >= maxPhotos || usedBytes + compressed.length > quota) return null;
            const id = `${Date.now()}-${randomUUID()}.webp`, temp = path.join(directory, `.${id}.tmp`);
            try { await writeFile(temp, compressed, { flag: 'wx' }); await rename(temp, path.join(directory, id)); }
            catch (error) { await unlink(temp).catch(() => {}); throw error; }
            const item = { id, url: `/images/${id}` }; photos.push(item); usedBytes += compressed.length; broadcast(); return item;
          });
          return photo ? json(res, 201, photo) : json(res, 507, { error: 'الحائط ممتلئ حاليًا. تواصل مع صاحب الموقع.' });
        } finally { activeUploads--; }
      }
      if (req.method === 'DELETE' && /^\/api\/photos\/\d+-[\da-f-]{36}\.webp$/.test(url.pathname)) {
        const supplied = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${adminToken}`);
        if (!adminToken || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 401, { error: 'غير مصرح.' });
        const id = url.pathname.split('/').at(-1);
        const removed = await serialize(async () => { if (!photos.some(p => p.id === id)) return false; const file = path.join(directory, id); const info = await stat(file); await unlink(file); usedBytes -= info.size; photos = photos.filter(p => p.id !== id); broadcast(); return true; });
        return json(res, removed ? 200 : 404, { ok: removed });
      }
      if (req.method === 'GET' && /^\/images\/\d+-[\da-f-]{36}\.webp$/.test(url.pathname)) {
        const id = url.pathname.split('/').at(-1); if (!photos.some(p => p.id === id)) return json(res, 404, { error: 'الصورة غير موجودة.' });
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
        const stream = createReadStream(path.join(directory, id)); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/layout.js': ['layout.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method === 'GET' && files[url.pathname]) { const [file, type] = files[url.pathname]; const body = await readFile(path.join(root, 'public', file)); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); return res.end(body); }
      json(res, 404, { error: 'الصفحة غير موجودة.' });
    } catch (error) { console.error(error.code || error.message); if (!res.headersSent) json(res, 500, { error: 'تعذّر إكمال الطلب. حاول مجددًا.' }); else res.destroy(); }
  });
  server.requestTimeout = 30000;
  server.on('close', () => clearInterval(heartbeat));
  return { server, close: async () => { clearInterval(heartbeat); for (const res of clients) res.end(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp(); app.server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('IMGE listening on port', process.env.PORT || 3000));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.close().then(() => process.exit(0)));
}
