import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { HttpError, CORS_HEADERS } from './http.js';

// Tipovi koje smijemo prikazati direktno (slike, video, zvuk). Sve ostalo ide kao download.
const INLINE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/ogg',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-wav',
  'text/plain', 'application/pdf',
]);

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mkv: 'video/x-matroska', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac',
  txt: 'text/plain', log: 'text/plain', pdf: 'application/pdf', zip: 'application/zip',
};

export function guessMime(filename, declared) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const fromExt = EXT_MIME[ext];
  const d = String(declared || '').split(';')[0].trim().toLowerCase();
  if (d && d !== 'application/octet-stream' && /^[a-z]+\/[a-z0-9.+-]+$/.test(d)) return d;
  return fromExt || 'application/octet-stream';
}

export function safeFilename(name) {
  const cleaned = String(name || 'fajl')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return cleaned || 'fajl';
}

export function filePath(filesDir, key) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new HttpError(404, 'Nije pronađeno.', 'not_found');
  return path.join(filesDir, key);
}

// Upload: tijelo zahtjeva je sam fajl.
export async function receiveUpload(req, dest, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `Fajl je prevelik (max ${Math.round(maxBytes / 1024 / 1024)} MB).`, 'too_large');
  }
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) {
        cb(new HttpError(413, `Fajl je prevelik (max ${Math.round(maxBytes / 1024 / 1024)} MB).`, 'too_large'));
        return;
      }
      cb(null, chunk);
    },
  });
  const tmp = `${dest}.part`;
  try {
    await pipeline(req, limiter, fs.createWriteStream(tmp));
    if (size === 0) throw new HttpError(400, 'Prazan fajl.', 'empty');
    await fs.promises.rename(tmp, dest);
    return size;
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

export async function serveFile(req, res, absPath, { mime, filename }) {
  let stat;
  try {
    stat = await fs.promises.stat(absPath);
  } catch {
    throw new HttpError(404, 'Fajl ne postoji.', 'not_found');
  }
  const inline = INLINE.has(mime);
  const type = inline ? mime : 'application/octet-stream';
  const encoded = encodeURIComponent(filename);
  const headers = {
    ...CORS_HEADERS,
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
  };
  const range = req.headers.range;
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    if (m[1] === '') {
      start = Math.max(0, stat.size - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(absPath, { start, end }), res).catch(() => {});
}
