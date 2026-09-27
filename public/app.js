import { splitTiles } from './layout.js';
const $ = s => document.querySelector(s), wall = $('#wall'), tiles = $('#tiles'), modal = $('#upload-dialog');
let photos = [], selected = null, previewURL, uploading = false, toastTimer;
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4000); }
function arrange() { const rect = wall.getBoundingClientRect(), layout = splitTiles(photos.length, rect.width, rect.height); [...tiles.children].forEach((tile, i) => { const r = layout[i]; if (!r) return; Object.assign(tile.style, { left: `${r.x / rect.width * 100}%`, top: `${r.y / rect.height * 100}%`, width: `${r.width / rect.width * 100}%`, height: `${r.height / rect.height * 100}%` }); }); }
function render(next) {
  photos = next; wall.setAttribute('aria-busy', 'false'); $('#empty').hidden = !!photos.length; $('#count').textContent = `${photos.length.toLocaleString('ar')} صور`;
  const existing = new Map([...tiles.children].map(el => [el.dataset.id, el]));
  for (const [i, photo] of photos.entries()) { let tile = existing.get(photo.id); if (!tile) { tile = document.createElement('button'); tile.className = 'tile'; tile.dataset.id = photo.id; const img = document.createElement('img'); img.src = photo.url; img.alt = `صورة من المجتمع ${i + 1}`; img.decoding = 'async'; tile.append(img); tile.addEventListener('click', () => { $('#full-image').src = photo.url; $('#view-dialog').showModal(); }); } tile.setAttribute('aria-label', `عرض الصورة ${i + 1} كاملة`); tiles.append(tile); existing.delete(photo.id); }
  for (const tile of existing.values()) tile.remove(); arrange();
}
new ResizeObserver(arrange).observe(wall);
let refreshing = false, pollTimer;
async function refresh() {
  if (refreshing || uploading || document.hidden) return;
  refreshing = true;
  try { const response = await fetch('/api/photos', { cache: 'no-store' }); if (!response.ok) throw Error(); render(await response.json()); $('#connection').textContent = 'متصل · تحديث تلقائي'; $('#connection').classList.add('connected'); }
  catch { $('#connection').textContent = 'جارٍ إعادة الاتصال…'; $('#connection').classList.remove('connected'); }
  finally { refreshing = false; }
}
refresh(); pollTimer = setInterval(refresh, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
async function compress(file) {
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 24000000) throw Error('اختر صورة أصغر من 24 مليون بكسل.');
    const scale = Math.min(1, 1920 / bitmap.width, 1920 / bitmap.height);
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.76));
    if (!blob || blob.type !== 'image/webp') throw Error('متصفحك لا يدعم تجهيز الصورة. جرّب متصفحًا أحدث.');
    if (blob.size > 2 * 1024 * 1024) throw Error('الصورة كبيرة بعد الضغط. جرّب صورة أصغر.');
    return blob;
  } finally { bitmap.close(); }
}
function openUpload() { if (!modal.open) modal.showModal(); }
for (const button of document.querySelectorAll('.add')) button.addEventListener('click', openUpload);
for (const dialog of document.querySelectorAll('dialog')) { dialog.querySelector('.close').addEventListener('click', () => { if (dialog !== modal || !uploading) dialog.close(); }); dialog.addEventListener('click', e => { if (e.target === dialog && (dialog !== modal || !uploading)) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } }); }
modal.addEventListener('cancel', e => { if (uploading) e.preventDefault(); });
function select(file) { if (uploading || !file) return; $('#upload-error').textContent = ''; selected = null; $('#publish').disabled = true; if (!['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(file.type)) { $('#upload-error').textContent = 'اختر صورة بصيغة مدعومة.'; return; } if (file.size > 8 * 1024 * 1024) { $('#upload-error').textContent = 'حجم الصورة الأقصى 8 ميغابايت.'; return; } if (previewURL) URL.revokeObjectURL(previewURL); previewURL = URL.createObjectURL(file); $('#preview').src = previewURL; $('#preview').hidden = false; $('#picker-copy').hidden = true; selected = file; $('#publish').disabled = false; $('#file-info').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`; }
$('#file').addEventListener('change', e => select(e.target.files[0]));
for (const target of [wall, $('#picker')]) { let depth = 0; target.addEventListener('dragenter', e => { e.preventDefault(); depth++; wall.classList.add('dragging'); }); target.addEventListener('dragover', e => e.preventDefault()); target.addEventListener('dragleave', () => { if (--depth <= 0) wall.classList.remove('dragging'); }); target.addEventListener('drop', e => { e.preventDefault(); depth = 0; wall.classList.remove('dragging'); openUpload(); select(e.dataTransfer.files[0]); }); }
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
$('#upload-form').addEventListener('submit', async e => { e.preventDefault(); if (!selected || uploading) return; uploading = true; $('#publish').disabled = true; $('#file').disabled = true; $('#publish').textContent = 'جارٍ نشر صورتك…'; $('#upload-error').textContent = ''; try { const compressed = await compress(selected); const result = await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/webp' }, body: compressed }); const data = await result.json(); if (!result.ok) throw Error(data.error); if (!photos.some(photo => photo.id === data.id)) render([...photos, data]); modal.close(); toast('صورتك صارت جزءًا من الحائط!'); selected = null; $('#file').value = ''; $('#preview').hidden = true; $('#picker-copy').hidden = false; $('#file-info').textContent = 'تُعرض الصور المتحركة كصورة ثابتة.'; URL.revokeObjectURL(previewURL); } catch (error) { $('#upload-error').textContent = error.message === 'Failed to fetch' ? 'انقطع الاتصال. تحقق من الحائط قبل المحاولة مجددًا.' : error.message; } finally { uploading = false; $('#file').disabled = false; $('#publish').disabled = !selected; $('#publish').textContent = 'انشر صورتك ↖'; } });
$('#fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else if (wall.requestFullscreen) await wall.requestFullscreen(); else toast('ملء الشاشة غير مدعوم في هذا المتصفح.'); } catch { toast('تعذّر تفعيل ملء الشاشة.'); } });

if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  for (const tool of [
    { name: 'list_wall_photos', description: 'Read the photos currently visible on the shared wall.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute: () => ({ photos: photos.map(({id, url}) => ({id, url})) }) },
    { name: 'start_photo_upload', description: 'Open the photo selection dialog. Does not upload or publish anything.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false }, execute: () => { openUpload(); return { opened: true }; } }
  ]) Promise.resolve(document.modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {});
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
