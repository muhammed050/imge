import assets from './assets.js';
const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const limit = 2 * 1024 * 1024;
const idPattern = /^\d{13}-[\da-f-]{36}\.webp$/;
let recentList = null, lastList = 0;
async function list(bucket, fresh = false) {
  if (!fresh && recentList && Date.now() - lastList < 4000) return recentList;
  const result = await bucket.list({ prefix: 'photos/', limit: 1000 });
  recentList = result.objects.filter(p => idPattern.test(p.key.slice(7))).map(p => ({ id: p.key.slice(7), url: `/images/${p.key.slice(7)}`, size: p.size }));
  lastList = Date.now(); return recentList;
}
async function rateAllowed(request, bucket) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const minute = Math.floor(Date.now() / 60000);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${minute}:${ip}`));
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  // Timestamp and short-lived hash only; never persist the IP address itself.
  // Conditional writes make each of the ten slots atomic across Worker instances.
  for (let slot = 0; slot < 10; slot++) {
    const saved = await bucket.put(`limits/${minute}/${hash}/${slot}`, '', { onlyIf: { etagDoesNotMatch: '*' } });
    if (saved) return true;
  }
  return false;
}
async function cleanupLimits(bucket) {
  const oldest = Math.floor(Date.now() / 60000) - 2;
  const old = await bucket.list({ prefix: 'limits/', limit: 1000 });
  const keys = old.objects.filter(o => Number(o.key.split('/')[1]) < oldest).map(o => o.key);
  if (keys.length) await bucket.delete(keys);
}
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url), bucket = env.BUCKET;
      if (request.method === 'GET' && assets[url.pathname]) { const asset = assets[url.pathname]; return new Response(asset.body, { headers: { ...headers, 'Content-Type': asset.type, 'Cache-Control': 'no-cache' } }); }
      if (url.pathname === '/health') return json({ ok: !!bucket });
      if (!bucket) return json({ error: 'التخزين غير متاح مؤقتًا. حاول بعد قليل.' }, 503);
      if (request.method === 'GET' && url.pathname === '/api/photos') return json((await list(bucket)).map(({id, url}) => ({id, url})));
      if (request.method === 'POST' && url.pathname === '/api/photos') {
        if (request.headers.get('Sec-Fetch-Site') === 'cross-site' || (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin)) return json({ error: 'طلب غير مسموح.' }, 403);
        if (request.headers.get('Content-Type') !== 'image/webp') return json({ error: 'تعذّر تجهيز الصورة. أعد اختيارها.' }, 415);
        if (Number(request.headers.get('Content-Length')) > limit) return json({ error: 'الصورة أكبر من الحد المسموح بعد الضغط.' }, 413);
        if (!await rateAllowed(request, bucket)) return json({ error: 'وصلت للحد المؤقت. انتظر دقيقة ثم حاول مجددًا.' }, 429, { 'Retry-After': '60' });
        ctx.waitUntil(cleanupLimits(bucket).catch(error => console.error('cleanup', error.message)));
        const reader = request.body?.getReader(); if (!reader) return json({ error: 'اختر صورة أولًا.' }, 400);
        const chunks = []; let size = 0;
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); return json({ error: 'الصورة أكبر من الحد المسموح بعد الضغط.' }, 413); } chunks.push(value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const text = new TextDecoder();
        if (size < 20 || text.decode(bytes.slice(0, 4)) !== 'RIFF' || text.decode(bytes.slice(8, 12)) !== 'WEBP' || !['VP8 ', 'VP8L', 'VP8X'].includes(text.decode(bytes.slice(12, 16))) || new DataView(bytes.buffer).getUint32(4, true) + 8 !== size) return json({ error: 'ملف الصورة غير صالح.' }, 422);
        const current = await list(bucket, true);
        if (current.length >= 500 || current.reduce((total, p) => total + p.size, 0) + size > 512 * 1024 * 1024) return json({ error: 'الحائط ممتلئ حاليًا.' }, 507);
        const id = `${Date.now()}-${crypto.randomUUID()}.webp`;
        await bucket.put(`photos/${id}`, bytes, { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=86400' } });
        recentList = null;
        return json({ id, url: `/images/${id}` }, 201);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/images/')) {
        const id = url.pathname.slice(8); if (!idPattern.test(id)) return json({ error: 'الصورة غير موجودة.' }, 404);
        const image = await bucket.get(`photos/${id}`); if (!image) return json({ error: 'الصورة غير موجودة.' }, 404);
        return new Response(image.body, { headers: { ...headers, 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400', ETag: image.httpEtag } });
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/api/photos/')) {
        if (!env.ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'غير مصرح.' }, 401);
        const id = url.pathname.slice(12); if (!idPattern.test(id)) return json({ error: 'الصورة غير موجودة.' }, 404);
        await bucket.delete(`photos/${id}`); recentList = null; return json({ ok: true });
      }
      return json({ error: 'الصفحة غير موجودة.' }, 404);
    } catch (error) { console.error('request', error.message); return json({ error: 'تعذّر إكمال الطلب. حاول مجددًا.' }, 503); }
  }
};
