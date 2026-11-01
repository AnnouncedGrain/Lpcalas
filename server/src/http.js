export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || `http_${status}`;
  }
}

export const bad = (msg, code) => new HttpError(400, msg, code || 'bad_request');
export const unauthorized = (msg = 'Nisi prijavljen.') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'Nemaš dozvolu za ovo.') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Nije pronađeno.') => new HttpError(404, msg, 'not_found');
export const tooMany = (msg = 'Previše pokušaja, sačekaj malo.') => new HttpError(429, msg, 'rate_limited');

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Filename, X-Width, X-Height',
  'Access-Control-Max-Age': '86400',
};

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Zahtjev je prevelik.', 'too_large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw bad('Neispravan JSON.', 'bad_json');
  }
}

export async function readRaw(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Zahtjev je prevelik.', 'too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/\/:([a-zA-Z_]+)/g, (_, key) => {
          keys.push(key);
          return '/([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, regex, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params = {};
      route.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1]);
        } catch {
          params[k] = m[i + 1];
        }
      });
      return { handler: route.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

// Validacija
export function str(value, field, { min = 0, max = 1000, trim = true, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw bad(`Polje "${field}" je obavezno.`, 'validation');
  }
  if (typeof value !== 'string') throw bad(`Polje "${field}" mora biti tekst.`, 'validation');
  const v = trim ? value.trim() : value;
  if (v.length < min) throw bad(`Polje "${field}" je prekratko (min ${min}).`, 'validation');
  if (v.length > max) throw bad(`Polje "${field}" je predugo (max ${max}).`, 'validation');
  return v;
}

export function id(value, field = 'id') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw bad(`Neispravan ${field}.`, 'validation');
  return n;
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
