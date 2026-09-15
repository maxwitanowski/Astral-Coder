// Images for the chat composer: pasted screenshots, dropped files and files
// picked in the dialog all become { kind: 'image', id, name, media_type, data }
// attachments, sent to Claude as base64 image blocks. Anything larger than the
// API's comfortable size is scaled down here before it leaves the renderer.
import { uid } from './store.js';

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const isImageFile = (name) => /\.(png|jpe?g|gif|webp)$/i.test(String(name || ''));
const MAX_EDGE = 1568;            // Anthropic's recommended longest edge
const MAX_BYTES = 4 * 1024 * 1024; // keep the base64 payload well under the 5 MB limit

const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Not a readable image')); im.src = src; });
const blobToDataUrl = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });

// Build an attachment from a data URL. Re-encodes (as JPEG) only when the
// image is too big; otherwise the original bytes go through untouched.
export async function imageFromDataUrl(dataUrl, name = 'image') {
  const im = await load(dataUrl);
  let media_type = (dataUrl.match(/^data:([^;]+);/) || [])[1] || 'image/png';
  let data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const tooBig = im.naturalWidth > MAX_EDGE || im.naturalHeight > MAX_EDGE || data.length * 0.75 > MAX_BYTES || !IMAGE_TYPES.has(media_type);
  if (tooBig) {
    const k = Math.min(1, MAX_EDGE / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(im.naturalWidth * k)); c.height = Math.max(1, Math.round(im.naturalHeight * k));
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(im, 0, 0, c.width, c.height);
    let q = 0.9; let out = c.toDataURL('image/jpeg', q);
    while (out.length * 0.75 > MAX_BYTES && q > 0.4) { q -= 0.15; out = c.toDataURL('image/jpeg', q); }
    dataUrl = out; media_type = 'image/jpeg'; data = out.slice(out.indexOf(',') + 1);
  }
  return { kind: 'image', id: uid(), name, media_type, data, dataUrl, w: im.naturalWidth, h: im.naturalHeight };
}
export async function imageFromBlob(blob, name) { return imageFromDataUrl(await blobToDataUrl(blob), name || blob.name || 'image'); }

// Image files out of a paste or drop event (screenshots arrive as a File with an empty name).
export function imageFilesOf(dt) {
  if (!dt) return [];
  const out = [];
  for (const f of dt.files || []) if (f.type && f.type.startsWith('image/')) out.push(f);
  if (!out.length && dt.items) for (const it of dt.items) if (it.kind === 'file' && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) out.push(f); }
  return out;
}
