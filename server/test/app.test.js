import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { signJwt, verifyJwt } from '../src/security.js';

const API_KEY = 'testkey';
const API_SECRET = 'testsecret_testsecret_testsecret_1234';

let app;
let base;
let dataDir;
let fake; // lažni LiveKit
let fakeRooms = {}; // room -> [identity]
let lastTwirpAuth = null;

function startFakeLiveKit() {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      lastTwirpAuth = req.headers.authorization;
      if (req.url.endsWith('/ListRooms')) {
        res.end(JSON.stringify({ rooms: Object.keys(fakeRooms).map((name) => ({ name })) }));
      } else if (req.url.endsWith('/ListParticipants')) {
        res.end(JSON.stringify({ participants: (fakeRooms[body.room] || []).map((identity) => ({ identity })) }));
      } else if (req.url.endsWith('/RemoveParticipant')) {
        fakeRooms[body.room] = (fakeRooms[body.room] || []).filter((i) => i !== body.identity);
        res.end('{}');
      } else if (req.url.startsWith('/rtc/validate')) {
        res.end('success');
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    // Minimalni "WebSocket" odgovor da provjerimo upgrade proxy.
    srv.on('upgrade', (req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Url: ' + req.url + '\r\n\r\n');
      socket.on('data', (d) => socket.write(d)); // echo
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function api(method, p, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* nije json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpcalas-test-'));
  fake = await startFakeLiveKit();
  const config = loadConfig({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    maxUploadBytes: 1024 * 1024,
    livekit: { apiKey: API_KEY, apiSecret: API_SECRET, internalUrl: `http://127.0.0.1:${fake.address().port}`, publicUrl: '' },
  });
  app = createApp(config, { log: { info() {}, warn() {}, error: console.error } });
  const addr = await app.start();
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.stop();
  fake.closeAllConnections();
  fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const state = {};

test('health i server-info su javni', async () => {
  const h = await api('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, true);
  const info = await api('GET', '/api/server-info');
  assert.equal(info.json.name, 'Lpcalas');
  assert.equal(info.json.needsFirstUser, true);
  assert.equal(info.json.voiceEnabled, true);
  assert.match(info.json.livekitUrl, /^ws:\/\/127\.0\.0\.1:\d+$/);
});

test('zaštićene rute traže prijavu', async () => {
  const r = await api('GET', '/api/bootstrap');
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'unauthorized');
});

test('prvi korisnik se registruje kodom iz fajla i postaje admin', async () => {
  const note = fs.readFileSync(path.join(dataDir, 'PRVA-POZIVNICA.txt'), 'utf8');
  const code = /([A-Z2-9]{5}-[A-Z2-9]{5})/.exec(note)[1];
  const bad = await api('POST', '/api/auth/register', { body: { username: 'tarik', password: 'kratka', invite: code } });
  assert.equal(bad.status, 400);
  const res = await api('POST', '/api/auth/register', {
    body: { username: 'tarik', password: 'lozinka123', displayName: 'Tarik', invite: code.toLowerCase() },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.user.role, 'admin');
  state.admin = res.json;
  assert.equal(fs.existsSync(path.join(dataDir, 'PRVA-POZIVNICA.txt')), false);
  const again = await api('POST', '/api/auth/register', { body: { username: 'drugi', password: 'lozinka123', invite: code } });
  assert.equal(again.status, 400);
  assert.equal(again.json.error, 'bad_invite');
});

test('admin pravi pozivnicu, drugi korisnik se registruje kao member', async () => {
  const inv = await api('POST', '/api/invites', { token: state.admin.token, body: { uses: 2 } });
  assert.equal(inv.status, 200);
  const res = await api('POST', '/api/auth/register', {
    body: { username: 'Emir', password: 'lozinka456', invite: inv.json.code },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.user.role, 'member');
  assert.equal(res.json.user.displayName, 'Emir');
  state.member = res.json;
  const dup = await api('POST', '/api/auth/register', { body: { username: 'emir', password: 'lozinka456', invite: inv.json.code } });
  assert.equal(dup.status, 409);
  const forbidden = await api('POST', '/api/invites', { token: state.member.token, body: {} });
  assert.equal(forbidden.status, 403);
});

test('login radi, pogrešna lozinka ne', async () => {
  const bad = await api('POST', '/api/auth/login', { body: { username: 'emir', password: 'pogresno123' } });
  assert.equal(bad.status, 401);
  const ok = await api('POST', '/api/auth/login', { body: { username: 'EMIR', password: 'lozinka456' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token);
});

test('bootstrap vraća kanale i korisnike', async () => {
  const r = await api('GET', '/api/bootstrap', { token: state.member.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.me.username, 'Emir');
  assert.equal(r.json.users.length, 2);
  const text = r.json.channels.filter((c) => c.type === 'text');
  const voice = r.json.channels.filter((c) => c.type === 'voice');
  assert.deepEqual(text.map((c) => c.name), ['opšte', 'klipovi']);
  assert.deepEqual(voice.map((c) => c.name), ['Lobby', 'Gaming 1', 'Gaming 2']);
  state.text = text[0];
  state.voice = voice[0];
});

test('poruke: slanje, uređivanje, reakcije, brisanje, paginacija', async () => {
  const ch = state.text.id;
  const empty = await api('POST', `/api/channels/${ch}/messages`, { token: state.member.token, body: { content: '   ' } });
  assert.equal(empty.status, 400);
  const sent = await api('POST', `/api/channels/${ch}/messages`, { token: state.member.token, body: { content: 'Ćao ekipa 👋' } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.content, 'Ćao ekipa 👋');
  const reply = await api('POST', `/api/channels/${ch}/messages`, {
    token: state.admin.token,
    body: { content: 'Evo me', replyTo: sent.json.id },
  });
  assert.equal(reply.json.replyTo.id, sent.json.id);

  const editOther = await api('PATCH', `/api/messages/${sent.json.id}`, { token: state.admin.token, body: { content: 'x' } });
  assert.equal(editOther.status, 403);
  const edited = await api('PATCH', `/api/messages/${sent.json.id}`, { token: state.member.token, body: { content: 'Ćao svima' } });
  assert.equal(edited.json.content, 'Ćao svima');
  assert.ok(edited.json.editedAt);

  const emoji = encodeURIComponent('🔥');
  const r1 = await api('PUT', `/api/messages/${sent.json.id}/reactions/${emoji}`, { token: state.admin.token });
  assert.deepEqual(r1.json.reactions, [{ emoji: '🔥', userIds: [state.admin.user.id] }]);
  const r2 = await api('DELETE', `/api/messages/${sent.json.id}/reactions/${emoji}`, { token: state.admin.token });
  assert.deepEqual(r2.json.reactions, []);

  for (let i = 0; i < 3; i++) {
    await api('POST', `/api/channels/${ch}/messages`, { token: state.admin.token, body: { content: `poruka ${i}` } });
  }
  const page1 = await api('GET', `/api/channels/${ch}/messages?limit=2`, { token: state.member.token });
  assert.equal(page1.json.messages.length, 2);
  assert.equal(page1.json.hasMore, true);
  assert.equal(page1.json.messages[1].content, 'poruka 2');
  const page2 = await api('GET', `/api/channels/${ch}/messages?limit=2&before=${page1.json.messages[0].id}`, { token: state.member.token });
  assert.equal(page2.json.messages[1].content, 'poruka 0');

  const delOther = await api('DELETE', `/api/messages/${reply.json.id}`, { token: state.member.token });
  assert.equal(delOther.status, 403);
  const delAdmin = await api('DELETE', `/api/messages/${sent.json.id}`, { token: state.admin.token });
  assert.equal(delAdmin.status, 200);
  const all = await api('GET', `/api/channels/${ch}/messages`, { token: state.member.token });
  const replyAfter = all.json.messages.find((m) => m.id === reply.json.id);
  assert.equal(replyAfter.replyTo.deleted, true);
});

test('upload slike, poruka s prilogom, Range zahtjev, limit veličine', async () => {
  const bytes = crypto.randomBytes(5000);
  const up = await api('POST', '/api/uploads', {
    token: state.member.token,
    headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('slika ekrana.png'), 'X-Width': '800', 'X-Height': '600' },
    raw: bytes,
  });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.mime, 'image/png');
  assert.equal(up.json.width, 800);
  assert.equal(up.json.size, 5000);

  const msg = await api('POST', `/api/channels/${state.text.id}/messages`, {
    token: state.member.token,
    body: { content: '', attachmentIds: [up.json.id] },
  });
  assert.equal(msg.status, 200, msg.text);
  assert.equal(msg.json.attachments[0].filename, 'slika ekrana.png');

  const reuse = await api('POST', `/api/channels/${state.text.id}/messages`, {
    token: state.admin.token,
    body: { content: 'krađa', attachmentIds: [up.json.id] },
  });
  assert.equal(reuse.status, 400);

  const full = await fetch(base + up.json.url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

  const part = await fetch(base + up.json.url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/5000');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100, 200));

  const html = await api('POST', '/api/uploads', {
    token: state.member.token,
    headers: { 'Content-Type': 'text/html', 'X-Filename': 'opasno.html' },
    raw: '<script>alert(1)</script>',
  });
  const served = await fetch(base + html.json.url);
  assert.equal(served.headers.get('content-type'), 'application/octet-stream');
  assert.match(served.headers.get('content-disposition'), /^attachment/);

  const big = await api('POST', '/api/uploads', {
    token: state.member.token,
    headers: { 'Content-Type': 'video/mp4', 'X-Filename': 'veliki.mp4' },
    raw: Buffer.alloc(1024 * 1024 + 10),
  });
  assert.equal(big.status, 413);
});

test('glas: token je ispravan LiveKit JWT', async () => {
  const r = await api('POST', '/api/voice/token', { token: state.member.token, body: { channelId: state.voice.id } });
  assert.equal(r.status, 200, r.text);
  const claims = verifyJwt(r.json.token, API_SECRET);
  assert.ok(claims);
  assert.equal(claims.iss, API_KEY);
  assert.equal(claims.sub, String(state.member.user.id));
  assert.equal(claims.video.room, `voice-${state.voice.id}`);
  assert.equal(claims.video.roomJoin, true);
  const wrong = await api('POST', '/api/voice/token', { token: state.member.token, body: { channelId: state.text.id } });
  assert.equal(wrong.status, 400);
});

function signedWebhook(event) {
  const body = JSON.stringify(event);
  const sha = crypto.createHash('sha256').update(body).digest('base64');
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({ iss: API_KEY, nbf: now, exp: now + 60, sha256: sha }, API_SECRET);
  return { body, token };
}

test('webhook: potpis se provjerava, join/leave ažurira stanje', async () => {
  const room = `voice-${state.voice.id}`;
  const forged = await api('POST', '/api/livekit/webhook', {
    headers: { Authorization: 'nesto', 'Content-Type': 'application/webhook+json' },
    raw: JSON.stringify({ event: 'participant_joined' }),
  });
  assert.equal(forged.status, 401);

  const join = signedWebhook({ event: 'participant_joined', room: { name: room }, participant: { identity: String(state.member.user.id) } });
  const r = await api('POST', '/api/livekit/webhook', { headers: { Authorization: join.token, 'Content-Type': 'application/webhook+json' }, raw: join.body });
  assert.equal(r.status, 200, r.text);
  let boot = await api('GET', '/api/bootstrap', { token: state.admin.token });
  assert.deepEqual(boot.json.voice[state.voice.id].map((v) => v.userId), [state.member.user.id]);

  // Tijelo promijenjeno nakon potpisa -> odbijeno
  const tampered = await api('POST', '/api/livekit/webhook', {
    headers: { Authorization: join.token, 'Content-Type': 'application/webhook+json' },
    raw: join.body.replace('participant_joined', 'participant_left'),
  });
  assert.equal(tampered.status, 401);

  const leave = signedWebhook({ event: 'participant_left', room: { name: room }, participant: { identity: String(state.member.user.id) } });
  await api('POST', '/api/livekit/webhook', { headers: { Authorization: leave.token }, raw: leave.body });
  boot = await api('GET', '/api/bootstrap', { token: state.admin.token });
  assert.equal(boot.json.voice[state.voice.id], undefined);
});

test('sinhronizacija s LiveKitom dodaje i uklanja članove', async () => {
  fakeRooms = { [`voice-${state.voice.id}`]: [String(state.admin.user.id)], 'nesto-drugo': ['x'] };
  await app.syncVoice();
  assert.ok(verifyJwt(lastTwirpAuth.replace('Bearer ', ''), API_SECRET));
  let boot = await api('GET', '/api/bootstrap', { token: state.admin.token });
  assert.deepEqual(boot.json.voice[state.voice.id].map((v) => v.userId), [state.admin.user.id]);
  fakeRooms = {};
  await app.syncVoice();
  boot = await api('GET', '/api/bootstrap', { token: state.admin.token });
  assert.deepEqual(boot.json.voice, {});
});

test('voice/state: klijent prijavljuje kanal i mute status', async () => {
  await api('POST', '/api/voice/state', { token: state.member.token, body: { channelId: state.voice.id, muted: true } });
  const boot = await api('GET', '/api/bootstrap', { token: state.admin.token });
  const entry = boot.json.voice[state.voice.id][0];
  assert.equal(entry.userId, state.member.user.id);
  assert.equal(entry.muted, true);
  assert.equal(entry.deafened, false);
  await api('POST', '/api/voice/state', { token: state.member.token, body: { channelId: null } });
});

test('SSE: događaji stižu u realnom vremenu', async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events?token=${state.admin.token}`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const waitFor = async (type) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const idx = buf.indexOf(`event: ${type}\n`);
      if (idx !== -1) {
        const end = buf.indexOf('\n\n', idx);
        if (end !== -1) {
          const block = buf.slice(idx, end);
          buf = buf.slice(end + 2);
          return JSON.parse(block.split('\ndata: ')[1]);
        }
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    throw new Error(`nije stigao događaj ${type}`);
  };
  const hello = await waitFor('hello');
  assert.ok(hello.online.includes(state.admin.user.id));
  await api('POST', `/api/channels/${state.text.id}/messages`, { token: state.member.token, body: { content: 'live!' } });
  const msg = await waitFor('message');
  assert.equal(msg.content, 'live!');
  await api('POST', `/api/channels/${state.text.id}/typing`, { token: state.member.token });
  const typing = await waitFor('typing');
  assert.equal(typing.userId, state.member.user.id);
  ac.abort();
});

test('LiveKit signal proxy: HTTP i WebSocket upgrade', async () => {
  const v = await fetch(`${base}/rtc/validate?access_token=x`);
  assert.equal(await v.text(), 'success');

  const port = Number(new URL(base).port);
  const result = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET /rtc?access_token=abc HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let data = '';
    sock.on('data', (d) => {
      data += d.toString();
      if (data.includes('\r\n\r\n') && !data.includes('PING')) sock.write('PING');
      if (data.includes('PING')) {
        sock.end();
        resolve(data);
      }
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  });
  assert.match(result, /101 Switching Protocols/);
  assert.match(result, /X-Seen-Url: \/rtc\?access_token=abc/);
  assert.match(result, /PING$/);
});

test('admin onemogućava korisnika: sesije prestaju važiti', async () => {
  const forbidden = await api('PATCH', `/api/users/${state.admin.user.id}`, { token: state.member.token, body: { disabled: true } });
  assert.equal(forbidden.status, 403);
  const r = await api('PATCH', `/api/users/${state.member.user.id}`, { token: state.admin.token, body: { disabled: true } });
  assert.equal(r.json.disabled, true);
  const after = await api('GET', '/api/bootstrap', { token: state.member.token });
  assert.equal(after.status, 401);
  const login = await api('POST', '/api/auth/login', { body: { username: 'emir', password: 'lozinka456' } });
  assert.equal(login.status, 403);
});

test('promjena lozinke i imena', async () => {
  const wrong = await api('PATCH', '/api/me', { token: state.admin.token, body: { password: { current: 'nije', new: 'novalozinka1' } } });
  assert.equal(wrong.status, 400);
  const ok = await api('PATCH', '/api/me', {
    token: state.admin.token,
    body: { displayName: 'Tarik T.', password: { current: 'lozinka123', new: 'novalozinka1' } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.displayName, 'Tarik T.');
  const login = await api('POST', '/api/auth/login', { body: { username: 'tarik', password: 'novalozinka1' } });
  assert.equal(login.status, 200);
});

test('admin upravlja kanalima', async () => {
  const c = await api('POST', '/api/channels', { token: state.admin.token, body: { name: 'CS2', type: 'voice' } });
  assert.equal(c.json.type, 'voice');
  assert.equal(c.json.position, 3);
  const renamed = await api('PATCH', `/api/channels/${c.json.id}`, { token: state.admin.token, body: { name: 'Counter-Strike' } });
  assert.equal(renamed.json.name, 'Counter-Strike');
  const del = await api('DELETE', `/api/channels/${c.json.id}`, { token: state.admin.token });
  assert.equal(del.status, 200);
});
