import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx, getSetting, setSetting } from './db.js';
import {
  Router, HttpError, sendJson, readJson, readRaw, str, id, bad, unauthorized, forbidden, notFound, tooMany,
  clientIp, CORS_HEADERS,
} from './http.js';
import { hashPassword, verifyPassword, newToken, sha256Hex, randomKey, inviteCode, RateLimiter } from './security.js';
import { Hub } from './hub.js';
import { LiveKit, roomName, channelIdFromRoom } from './livekit.js';
import { receiveUpload, serveFile, filePath, guessMime, safeFilename } from './files.js';
import { isRtcPath, proxyHttp, proxyUpgrade } from './proxy.js';

export const VERSION = '0.2.6';
const BOT_USERNAME = 'lpcalas.bot';
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;
const MAX_MESSAGE = 4000;
const PAGE = 50;
const ROLES = new Set(['admin', 'member']);

export function createApp(config, { log = console } = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const filesDir = path.join(config.dataDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const db = openDb(path.join(config.dataDir, 'lpcalas.db'));
  const hub = new Hub();
  const livekit = new LiveKit(config.livekit);
  const authLimiter = new RateLimiter(10, 5 * 60 * 1000);
  const messageLimiter = new RateLimiter(10, 5000);
  const uploadLimiter = new RateLimiter(30, 60 * 1000);
  const now = () => Date.now();


  // ---------- serijalizacija ----------

  const userStmt = db.prepare('SELECT * FROM users WHERE id = ?');
  let botId = 0;
  seed();

  function humanCount() {
    return db.prepare('SELECT COUNT(*) AS n FROM users WHERE username != ?').get(BOT_USERNAME).n;
  }

  function publicUser(u) {
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      avatarUrl: u.avatar_key ? `/a/${u.avatar_key}` : null,
      disabled: Boolean(u.disabled),
      bot: u.username === BOT_USERNAME,
      createdAt: u.created_at,
    };
  }

  function publicChannel(c) {
    return { id: c.id, name: c.name, type: c.type, position: c.position, readonly: Boolean(c.readonly) };
  }

  function publicAttachment(a) {
    return {
      id: a.id,
      url: `/f/${a.key}/${encodeURIComponent(a.filename)}`,
      filename: a.filename,
      mime: a.mime,
      size: a.size,
      width: a.width,
      height: a.height,
    };
  }

  function hydrateMessages(rows) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const atts = db.prepare(`SELECT * FROM attachments WHERE message_id IN (${marks}) ORDER BY id`).all(...ids);
    const reacts = db
      .prepare(`SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${marks}) ORDER BY created_at`)
      .all(...ids);
    const replyIds = [...new Set(rows.map((r) => r.reply_to).filter(Boolean))];
    const replies = new Map();
    if (replyIds.length) {
      const rm = replyIds.map(() => '?').join(',');
      for (const r of db.prepare(`SELECT id, user_id, content FROM messages WHERE id IN (${rm})`).all(...replyIds)) {
        replies.set(r.id, { id: r.id, userId: r.user_id, content: r.content.slice(0, 200) });
      }
    }
    return rows.map((r) => {
      const reactionMap = new Map();
      for (const x of reacts) {
        if (x.message_id !== r.id) continue;
        if (!reactionMap.has(x.emoji)) reactionMap.set(x.emoji, []);
        reactionMap.get(x.emoji).push(x.user_id);
      }
      return {
        id: r.id,
        channelId: r.channel_id,
        userId: r.user_id,
        content: r.content,
        replyTo: r.reply_to ? replies.get(r.reply_to) || { id: r.reply_to, deleted: true } : null,
        createdAt: r.created_at,
        editedAt: r.edited_at,
        attachments: atts.filter((a) => a.message_id === r.id).map(publicAttachment),
        reactions: [...reactionMap.entries()].map(([emoji, userIds]) => ({ emoji, userIds })),
      };
    });
  }

  function loadMessage(messageId) {
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    return row ? hydrateMessages([row])[0] : null;
  }

  // ---------- auth ----------

  function authenticate(req, url) {
    const header = req.headers.authorization || '';
    let token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token && url) token = url.searchParams.get('token') || '';
    if (!token) return null;
    const hash = sha256Hex(token);
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
    if (!session) return null;
    const user = userStmt.get(session.user_id);
    if (!user || user.disabled) return null;
    if (now() - session.last_seen > 5 * 60 * 1000) {
      db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), hash);
    }
    return { user, tokenHash: hash };
  }

  function createSession(userId, userAgent) {
    const token = newToken();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?)')
      .run(sha256Hex(token), userId, now(), now(), String(userAgent || '').slice(0, 200));
    return token;
  }

  const requireAdmin = (ctx) => {
    if (ctx.user.role !== 'admin') throw forbidden('Samo admin može ovo.');
  };

  // ---------- seed ----------

  function seed() {
    const channels = db.prepare('SELECT COUNT(*) AS n FROM channels').get().n;
    if (channels === 0) {
      const ins = db.prepare('INSERT INTO channels (name, type, position, created_at) VALUES (?, ?, ?, ?)');
      tx(db, () => {
        ins.run('opšte', 'text', 0, now());
        ins.run('klipovi', 'text', 1, now());
        ins.run('Lobby', 'voice', 0, now());
        ins.run('Gaming 1', 'voice', 1, now());
        ins.run('Gaming 2', 'voice', 2, now());
      });
    }
    // Sistemski korisnik koji piše changelog (ne može se prijaviti) i kanal za changelog.
    let bot = db.prepare('SELECT * FROM users WHERE username = ?').get(BOT_USERNAME);
    if (!bot) {
      const info = db
        .prepare("INSERT INTO users (username, display_name, password_hash, role, disabled, created_at) VALUES (?, 'Lpcalas', 'nologin', 'member', 1, ?)")
        .run(BOT_USERNAME, now());
      bot = userStmt.get(Number(info.lastInsertRowid));
    }
    botId = bot.id;
    let changelog = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(getSetting(db, 'changelog_channel')) || 0);
    if (!changelog) {
      const pos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE type = 'text'").get().p;
      const info = db
        .prepare("INSERT INTO channels (name, type, position, readonly, created_at) VALUES ('changelog', 'text', ?, 1, ?)")
        .run(pos, now());
      setSetting(db, 'changelog_channel', Number(info.lastInsertRowid));
    }
    const users = humanCount();
    if (users === 0) {
      let code = getSetting(db, 'first_invite');
      const exists = code && db.prepare('SELECT 1 FROM invites WHERE code = ?').get(code);
      if (!exists) {
        code = inviteCode();
        db.prepare('INSERT INTO invites (code, created_by, uses_left, expires_at, created_at) VALUES (?, NULL, 1, NULL, ?)')
          .run(code, now());
        setSetting(db, 'first_invite', code);
      }
      const note = path.join(config.dataDir, 'PRVA-POZIVNICA.txt');
      fs.writeFileSync(
        note,
        `Pozivni kod za prvi nalog (taj nalog postaje admin):\n\n    ${code}\n\nNakon registracije ovaj fajl možeš obrisati.\n`,
      );
      log.info?.(`\n=== PRVI POZIVNI KOD (postaje admin): ${code} ===\n(sačuvano i u ${note})\n`);
    }
  }

  // ---------- rute ----------

  const r = new Router();

  r.get('/api/health', () => ({ ok: true, version: VERSION }));

  r.get('/api/server-info', (ctx) => ({
    name: config.serverName,
    version: VERSION,
    livekitUrl: livekitUrlFor(ctx.req),
    voiceEnabled: livekit.configured,
    maxUploadBytes: config.maxUploadBytes,
    needsFirstUser: humanCount() === 0,
  }));

  r.post('/api/auth/register', async (ctx) => {
    if (!authLimiter.allow(`reg:${ctx.ip}`)) throw tooMany();
    const body = await readJson(ctx.req);
    const username = str(body.username, 'korisničko ime', { min: 3, max: 24 });
    if (!USERNAME_RE.test(username)) {
      throw bad('Korisničko ime smije imati samo slova, brojeve i znakove _ . - (3-24 znaka).', 'validation');
    }
    const password = str(body.password, 'lozinka', { min: 8, max: 200, trim: false });
    const displayName = str(body.displayName || username, 'ime za prikaz', { min: 1, max: 32 });
    const code = str(body.invite, 'pozivni kod', { min: 1, max: 40 }).toUpperCase();
    const passwordHash = await hashPassword(password);
    const user = tx(db, () => {
      const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
      if (!invite) throw bad('Pozivni kod ne postoji.', 'bad_invite');
      if (invite.expires_at && invite.expires_at < now()) throw bad('Pozivni kod je istekao.', 'bad_invite');
      if (invite.uses_left !== null && invite.uses_left <= 0) throw bad('Pozivni kod je već iskorišten.', 'bad_invite');
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        throw new HttpError(409, 'To korisničko ime je zauzeto.', 'username_taken');
      }
      const isFirst = humanCount() === 0;
      const info = db
        .prepare('INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(username, displayName, passwordHash, isFirst ? 'admin' : 'member', now());
      if (invite.uses_left !== null) {
        db.prepare('UPDATE invites SET uses_left = uses_left - 1 WHERE code = ?').run(code);
      }
      return userStmt.get(Number(info.lastInsertRowid));
    });
    if (user.role === 'admin') fs.rmSync(path.join(config.dataDir, 'PRVA-POZIVNICA.txt'), { force: true });
    const token = createSession(user.id, ctx.req.headers['user-agent']);
    hub.broadcast('user', publicUser(user));
    return { token, user: publicUser(user) };
  });

  r.post('/api/auth/login', async (ctx) => {
    if (!authLimiter.allow(`login:${ctx.ip}`)) throw tooMany();
    const body = await readJson(ctx.req);
    const username = str(body.username, 'korisničko ime', { max: 64 });
    const password = str(body.password, 'lozinka', { max: 200, trim: false });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const ok = user ? await verifyPassword(password, user.password_hash) : false;
    if (!ok) throw unauthorized('Pogrešno korisničko ime ili lozinka.');
    if (user.disabled) throw forbidden('Ovaj nalog je onemogućen.');
    const token = createSession(user.id, ctx.req.headers['user-agent']);
    return { token, user: publicUser(user) };
  });

  r.post('/api/auth/logout', (ctx) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(ctx.tokenHash);
    return { ok: true };
  });

  r.get('/api/bootstrap', (ctx) => ({
    me: publicUser(ctx.user),
    server: { name: config.serverName, version: VERSION, maxUploadBytes: config.maxUploadBytes, voiceEnabled: livekit.configured, uploadMbps: Number(getSetting(db, 'upload_mbps')) || 0 },
    users: db.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE').all().map(publicUser),
    channels: db.prepare('SELECT * FROM channels ORDER BY type DESC, position, id').all().map(publicChannel),
    online: hub.onlineUserIds(),
    voice: hub.voiceSnapshot(),
  }));

  r.patch('/api/me', async (ctx) => {
    const body = await readJson(ctx.req);
    const user = ctx.user;
    if (body.displayName !== undefined) {
      const displayName = str(body.displayName, 'ime za prikaz', { min: 1, max: 32 });
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, user.id);
    }
    if (body.password !== undefined) {
      const current = str(body.password?.current, 'trenutna lozinka', { max: 200, trim: false });
      const next = str(body.password?.new, 'nova lozinka', { min: 8, max: 200, trim: false });
      if (!(await verifyPassword(current, user.password_hash))) throw bad('Trenutna lozinka nije tačna.', 'bad_password');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, ctx.tokenHash);
    }
    const updated = publicUser(userStmt.get(user.id));
    hub.broadcast('user', updated);
    return updated;
  });

  r.post('/api/me/avatar', async (ctx) => {
    const mime = guessMime('avatar', ctx.req.headers['content-type']);
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) throw bad('Avatar mora biti slika (png, jpg, gif, webp).', 'validation');
    const key = randomKey();
    await receiveUpload(ctx.req, filePath(filesDir, key), 5 * 1024 * 1024);
    const old = ctx.user.avatar_key;
    db.prepare('UPDATE users SET avatar_key = ? WHERE id = ?').run(`${key}.${mime.split('/')[1]}`, ctx.user.id);
    if (old) fs.rmSync(filePath(filesDir, old.split('.')[0]), { force: true });
    const updated = publicUser(userStmt.get(ctx.user.id));
    hub.broadcast('user', updated);
    return updated;
  });

  // ---------- kanali ----------

  function getChannel(channelId, type) {
    const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    if (!c) throw notFound('Kanal ne postoji.');
    if (type && c.type !== type) throw bad(type === 'text' ? 'To nije tekstualni kanal.' : 'To nije glasovni kanal.');
    return c;
  }

  r.post('/api/channels', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const name = str(body.name, 'naziv', { min: 1, max: 40 });
    const type = body.type === 'voice' ? 'voice' : 'text';
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE type = ?').get(type).p;
    const info = db.prepare('INSERT INTO channels (name, type, position, created_at) VALUES (?, ?, ?, ?)').run(name, type, pos, now());
    const channel = publicChannel(getChannel(Number(info.lastInsertRowid)));
    hub.broadcast('channel', channel);
    return channel;
  });

  r.patch('/api/channels/:id', async (ctx) => {
    requireAdmin(ctx);
    const c = getChannel(id(ctx.params.id));
    const body = await readJson(ctx.req);
    const name = body.name !== undefined ? str(body.name, 'naziv', { min: 1, max: 40 }) : c.name;
    const position = body.position !== undefined ? Number(body.position) | 0 : c.position;
    db.prepare('UPDATE channels SET name = ?, position = ? WHERE id = ?').run(name, position, c.id);
    const channel = publicChannel(getChannel(c.id));
    hub.broadcast('channel', channel);
    return channel;
  });

  r.delete('/api/channels/:id', (ctx) => {
    requireAdmin(ctx);
    const c = getChannel(id(ctx.params.id));
    const keys = db
      .prepare('SELECT a.key FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id = ?')
      .all(c.id);
    db.prepare('DELETE FROM channels WHERE id = ?').run(c.id);
    for (const { key } of keys) fs.rmSync(filePath(filesDir, key), { force: true });
    hub.broadcast('channel.deleted', { id: c.id });
    return { ok: true };
  });

  // ---------- poruke ----------

  r.get('/api/channels/:id/messages', (ctx) => {
    const c = getChannel(id(ctx.params.id), 'text');
    const before = ctx.url.searchParams.get('before');
    const limit = Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('limit')) || PAGE));
    const rows = before
      ? db.prepare('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(c.id, id(before, 'before'), limit)
      : db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?').all(c.id, limit);
    rows.reverse();
    return { messages: hydrateMessages(rows), hasMore: rows.length === limit };
  });

  r.post('/api/channels/:id/messages', async (ctx) => {
    if (!messageLimiter.allow(`msg:${ctx.user.id}`)) throw tooMany('Šalješ poruke prebrzo.');
    const c = getChannel(id(ctx.params.id), 'text');
    if (c.readonly) throw forbidden('U ovaj kanal se ne može pisati.');
    const body = await readJson(ctx.req);
    const content = typeof body.content === 'string' ? body.content.replace(/\s+$/, '') : '';
    if (content.length > MAX_MESSAGE) throw bad(`Poruka je preduga (max ${MAX_MESSAGE} znakova).`, 'validation');
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.slice(0, 10).map((x) => id(x, 'prilog')) : [];
    if (!content.trim() && attachmentIds.length === 0) throw bad('Poruka je prazna.', 'validation');
    let replyTo = null;
    if (body.replyTo) {
      replyTo = id(body.replyTo, 'replyTo');
      const target = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(replyTo);
      if (!target || target.channel_id !== c.id) replyTo = null;
    }
    const messageId = tx(db, () => {
      const info = db
        .prepare('INSERT INTO messages (channel_id, user_id, content, reply_to, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(c.id, ctx.user.id, content, replyTo, now());
      const mid = Number(info.lastInsertRowid);
      for (const aid of attachmentIds) {
        const res = db
          .prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND uploader_id = ? AND message_id IS NULL')
          .run(mid, aid, ctx.user.id);
        if (res.changes !== 1) throw bad('Prilog ne postoji ili je već poslan.', 'bad_attachment');
      }
      return mid;
    });
    const message = loadMessage(messageId);
    hub.broadcast('message', message);
    return message;
  });

  r.patch('/api/messages/:id', async (ctx) => {
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id(ctx.params.id));
    if (!m) throw notFound('Poruka ne postoji.');
    if (m.user_id !== ctx.user.id) throw forbidden('Možeš uređivati samo svoje poruke.');
    const body = await readJson(ctx.req);
    const content = str(body.content, 'poruka', { min: 0, max: MAX_MESSAGE, trim: false }).replace(/\s+$/, '');
    const hasAtt = db.prepare('SELECT 1 FROM attachments WHERE message_id = ?').get(m.id);
    if (!content.trim() && !hasAtt) throw bad('Poruka ne može biti prazna.', 'validation');
    db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, now(), m.id);
    const message = loadMessage(m.id);
    hub.broadcast('message.updated', message);
    return message;
  });

  r.delete('/api/messages/:id', (ctx) => {
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id(ctx.params.id));
    if (!m) throw notFound('Poruka ne postoji.');
    if (m.user_id !== ctx.user.id && ctx.user.role !== 'admin') throw forbidden('Možeš brisati samo svoje poruke.');
    const keys = db.prepare('SELECT key FROM attachments WHERE message_id = ?').all(m.id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
    for (const { key } of keys) fs.rmSync(filePath(filesDir, key), { force: true });
    hub.broadcast('message.deleted', { id: m.id, channelId: m.channel_id });
    return { ok: true };
  });

  async function setReaction(ctx, add) {
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id(ctx.params.id));
    if (!m) throw notFound('Poruka ne postoji.');
    const emoji = str(ctx.params.emoji, 'emoji', { min: 1, max: 32 });
    if (add) {
      const count = db.prepare('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?').get(m.id).n;
      if (count >= 20) throw bad('Previše različitih reakcija.', 'validation');
      db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)')
        .run(m.id, ctx.user.id, emoji, now());
    } else {
      db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(m.id, ctx.user.id, emoji);
    }
    const message = loadMessage(m.id);
    hub.broadcast('message.updated', message);
    return message;
  }
  r.put('/api/messages/:id/reactions/:emoji', (ctx) => setReaction(ctx, true));
  r.delete('/api/messages/:id/reactions/:emoji', (ctx) => setReaction(ctx, false));

  r.post('/api/channels/:id/typing', (ctx) => {
    const c = getChannel(id(ctx.params.id), 'text');
    hub.broadcast('typing', { channelId: c.id, userId: ctx.user.id }, (uid) => uid !== ctx.user.id);
    return { ok: true };
  });

  // ---------- fajlovi ----------

  r.post('/api/uploads', async (ctx) => {
    if (!uploadLimiter.allow(`up:${ctx.user.id}`)) throw tooMany('Previše uploada, sačekaj minutu.');
    let filename = 'fajl';
    try {
      filename = decodeURIComponent(String(ctx.req.headers['x-filename'] || 'fajl'));
    } catch {
      /* ostavi default */
    }
    filename = safeFilename(filename);
    const mime = guessMime(filename, ctx.req.headers['content-type']);
    const dim = (h) => {
      const n = Number(ctx.req.headers[h]);
      return Number.isInteger(n) && n > 0 && n < 100000 ? n : null;
    };
    const key = randomKey();
    const size = await receiveUpload(ctx.req, filePath(filesDir, key), config.maxUploadBytes);
    const info = db
      .prepare('INSERT INTO attachments (key, message_id, uploader_id, filename, mime, size, width, height, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)')
      .run(key, ctx.user.id, filename, mime, size, dim('x-width'), dim('x-height'), now());
    return publicAttachment(db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  // ---------- glas ----------

  function livekitUrlFor(req) {
    if (config.livekit.publicUrl) return config.livekit.publicUrl;
    const proto = config.trustProxy && req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
    const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${config.port}`;
    return `${proto}://${host}`;
  }

  r.post('/api/voice/token', async (ctx) => {
    if (!livekit.configured) throw new HttpError(503, 'Glasovni server nije podešen.', 'voice_disabled');
    const body = await readJson(ctx.req);
    const c = getChannel(id(body.channelId, 'kanal'), 'voice');
    const token = livekit.joinToken({
      identity: String(ctx.user.id),
      name: ctx.user.display_name,
      room: roomName(c.id),
      metadata: { userId: ctx.user.id },
    });
    return { token, url: livekitUrlFor(ctx.req), room: roomName(c.id) };
  });

  r.post('/api/voice/state', async (ctx) => {
    const body = await readJson(ctx.req);
    if (body.channelId !== undefined) {
      const channelId = body.channelId === null ? null : getChannel(id(body.channelId, 'kanal'), 'voice').id;
      hub.setVoiceChannel(ctx.user.id, channelId);
    }
    hub.setVoiceFlags(ctx.user.id, {
      muted: body.muted,
      deafened: body.deafened,
      streaming: body.streaming,
    });
    return { ok: true };
  });

  r.post('/api/voice/kick', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const userId = id(body.userId, 'korisnik');
    const channelId = hub.channelOf(userId);
    if (channelId === null) throw bad('Korisnik nije u glasovnom kanalu.');
    if (livekit.configured) await livekit.removeParticipant(roomName(channelId), String(userId)).catch(() => {});
    hub.setVoiceChannel(userId, null);
    hub.sendToUser(userId, 'voice.kicked', { channelId });
    return { ok: true };
  });

  r.post('/api/livekit/webhook', async (ctx) => {
    const raw = await readRaw(ctx.req);
    const event = livekit.verifyWebhook(raw, ctx.req.headers.authorization);
    if (!event) throw unauthorized('Neispravan webhook potpis.');
    const channelId = channelIdFromRoom(event.room?.name);
    const userId = Number(event.participant?.identity);
    if (event.event === 'participant_joined' && channelId && Number.isSafeInteger(userId)) {
      if (userStmt.get(userId)) hub.setVoiceChannel(userId, channelId);
    } else if (event.event === 'participant_left' && channelId && Number.isSafeInteger(userId)) {
      if (hub.channelOf(userId) === channelId) hub.setVoiceChannel(userId, null);
    } else if (event.event === 'room_finished' && channelId) {
      const members = hub.voice.get(channelId);
      if (members) for (const uid of [...members.keys()]) hub.setVoiceChannel(uid, null);
    }
    return { ok: true };
  });

  async function syncVoice() {
    if (!livekit.configured) return;
    try {
      const rooms = await livekit.listRooms();
      const actual = new Map();
      for (const room of rooms) {
        const channelId = channelIdFromRoom(room.name);
        if (!channelId) continue;
        const participants = await livekit.listParticipants(room.name);
        const set = new Set();
        for (const p of participants) {
          const uid = Number(p.identity);
          if (Number.isSafeInteger(uid) && userStmt.get(uid)) set.add(uid);
        }
        if (set.size) actual.set(channelId, set);
      }
      hub.reconcileVoice(actual);
    } catch (err) {
      log.warn?.(`[voice sync] ${err.message}`);
    }
  }

  // ---------- poke (kao na TeamSpeaku) ----------

  const pokeLimiter = new RateLimiter(5, 30 * 1000);

  r.post('/api/users/:id/poke', async (ctx) => {
    const target = userStmt.get(id(ctx.params.id));
    if (!target || target.disabled) throw notFound('Korisnik ne postoji.');
    if (target.id === ctx.user.id) throw bad('Ne možeš pokeati sam sebe.');
    if (!pokeLimiter.allow(`poke:${ctx.user.id}`)) throw tooMany('Previše pokeova, sačekaj malo.');
    const body = await readJson(ctx.req);
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 200) : '';
    const online = hub.isOnline(target.id);
    hub.sendToUser(target.id, 'poke', { from: ctx.user.id, message, at: now() });
    return { delivered: online };
  });

  // ---------- changelog ----------
  // Aplikacija pošalje bilješke svoje verzije; server ih jednom objavi u kanalu #changelog.

  r.post('/api/changelog', async (ctx) => {
    const body = await readJson(ctx.req, 256 * 1024);
    const entries = Array.isArray(body.entries) ? body.entries.slice(0, 100) : [];
    const channelId = Number(getSetting(db, 'changelog_channel'));
    if (!db.prepare('SELECT 1 FROM channels WHERE id = ?').get(channelId)) return { posted: [] };
    const posted = [];
    for (const e of entries) {
      const version = String(e?.version || '');
      const notes = typeof e?.notes === 'string' ? e.notes.trim().slice(0, 3800) : '';
      if (!/^\d+\.\d+\.\d+$/.test(version) || !notes) continue;
      if (getSetting(db, `changelog:${version}`)) continue;
      const info = db
        .prepare('INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)')
        .run(channelId, botId, `**Verzija ${version}**\n${notes}`, now());
      setSetting(db, `changelog:${version}`, Number(info.lastInsertRowid));
      const message = loadMessage(Number(info.lastInsertRowid));
      hub.broadcast('message', message);
      posted.push(version);
    }
    return { posted };
  });

  // ---------- premještanje između glasovnih kanala ----------

  r.post('/api/voice/move', async (ctx) => {
    const body = await readJson(ctx.req);
    const userId = id(body.userId, 'korisnik');
    const target = getChannel(id(body.channelId, 'kanal'), 'voice');
    if (userId !== ctx.user.id) requireAdmin(ctx);
    const current = hub.channelOf(userId);
    if (current === null) throw bad('Korisnik nije u glasovnom kanalu.');
    if (current === target.id) return { ok: true };
    hub.sendToUser(userId, 'voice.move', { channelId: target.id, by: ctx.user.id });
    return { ok: true };
  });

  // ---------- admin ----------

  r.get('/api/invites', (ctx) => {
    requireAdmin(ctx);
    return db
      .prepare('SELECT * FROM invites ORDER BY created_at DESC')
      .all()
      .map((i) => ({ code: i.code, usesLeft: i.uses_left, expiresAt: i.expires_at, createdAt: i.created_at, createdBy: i.created_by }));
  });

  r.post('/api/invites', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const uses = body.uses === null || body.uses === undefined ? 1 : Math.max(1, Math.min(100, Number(body.uses) | 0));
    const hours = Number(body.expiresHours) > 0 ? Math.min(24 * 365, Number(body.expiresHours)) : null;
    const code = inviteCode();
    const expiresAt = hours ? now() + hours * 3600 * 1000 : null;
    db.prepare('INSERT INTO invites (code, created_by, uses_left, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(code, ctx.user.id, uses, expiresAt, now());
    return { code, usesLeft: uses, expiresAt };
  });

  r.delete('/api/invites/:code', (ctx) => {
    requireAdmin(ctx);
    db.prepare('DELETE FROM invites WHERE code = ?').run(String(ctx.params.code).toUpperCase());
    return { ok: true };
  });

  // Postavke servera (admin). uploadMbps = upload internet veze servera; streamovi se dijele unutar toga.
  r.patch('/api/server-settings', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const out = {};
    if (body.uploadMbps !== undefined) {
      const v = Number(body.uploadMbps);
      if (!Number.isFinite(v) || v < 0 || v > 100000) throw bad('Neispravan uploadMbps.', 'validation');
      setSetting(db, 'upload_mbps', Math.round(v));
      out.uploadMbps = Math.round(v);
    }
    hub.broadcast('server.settings', out);
    return out;
  });

  r.patch('/api/users/:id', async (ctx) => {
    requireAdmin(ctx);
    const target = userStmt.get(id(ctx.params.id));
    if (!target) throw notFound('Korisnik ne postoji.');
    const body = await readJson(ctx.req);
    if (body.role !== undefined) {
      if (!ROLES.has(body.role)) throw bad('Nepoznata uloga.');
      if (target.id === ctx.user.id && body.role !== 'admin') throw bad('Ne možeš sebi skinuti admina.');
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, target.id);
    }
    if (body.disabled !== undefined) {
      if (target.id === ctx.user.id) throw bad('Ne možeš onemogućiti sam sebe.');
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, target.id);
      if (body.disabled) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
        hub.disconnectUser(target.id);
        const ch = hub.channelOf(target.id);
        if (ch !== null) {
          if (livekit.configured) livekit.removeParticipant(roomName(ch), String(target.id)).catch(() => {});
          hub.setVoiceChannel(target.id, null);
        }
      }
    }
    const updated = publicUser(userStmt.get(target.id));
    hub.broadcast('user', updated);
    return updated;
  });

  // ---------- održavanje ----------

  function cleanupOrphans() {
    const cutoff = now() - 24 * 3600 * 1000;
    const rows = db.prepare('SELECT id, key FROM attachments WHERE message_id IS NULL AND created_at < ?').all(cutoff);
    for (const row of rows) {
      fs.rmSync(filePath(filesDir, row.key), { force: true });
      db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
    }
    db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(now() - 90 * 24 * 3600 * 1000);
  }

  // ---------- HTTP server ----------

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const ip = clientIp(req, config.trustProxy);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }
      if (isRtcPath(url.pathname)) {
        proxyHttp(req, res, config.livekit.internalUrl);
        return;
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        const auth = authenticate(req, url);
        if (!auth) throw unauthorized();
        hub.connect(req, res, auth.user.id);
        hub.send(res, 'hello', { online: hub.onlineUserIds(), voice: hub.voiceSnapshot(), ...hub.presenceSnapshot() });
        return;
      }
      let m = /^\/f\/([A-Za-z0-9_-]+)(?:\/.*)?$/.exec(url.pathname);
      if (m && (req.method === 'GET' || req.method === 'HEAD')) {
        const att = db.prepare('SELECT * FROM attachments WHERE key = ?').get(m[1]);
        if (!att) throw notFound('Fajl ne postoji.');
        await serveFile(req, res, filePath(filesDir, att.key), { mime: att.mime, filename: att.filename });
        return;
      }
      m = /^\/a\/([A-Za-z0-9_-]+)\.(png|jpeg|gif|webp)$/.exec(url.pathname);
      if (m && (req.method === 'GET' || req.method === 'HEAD')) {
        const owner = db.prepare('SELECT 1 FROM users WHERE avatar_key = ?').get(`${m[1]}.${m[2]}`);
        if (!owner) throw notFound();
        await serveFile(req, res, filePath(filesDir, m[1]), { mime: `image/${m[2]}`, filename: `avatar.${m[2]}` });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const match = r.match(req.method, url.pathname);
        if (!match) throw notFound('Nepoznata ruta.');
        if (match.methodNotAllowed) throw new HttpError(405, 'Metoda nije dozvoljena.', 'method_not_allowed');
        const ctx = { req, res, url, ip, params: match.params };
        if (!match.handler.public) {
          const auth = authenticate(req, url);
          if (!auth) throw unauthorized();
          ctx.user = auth.user;
          ctx.tokenHash = auth.tokenHash;
        }
        const result = await match.handler(ctx);
        if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
        return;
      }
      if (await serveStatic(req, res, url.pathname)) return;
      if (url.pathname === '/') {
        sendJson(res, 200, { app: 'Lpcalas server', version: VERSION });
        return;
      }
      throw notFound();
    } catch (err) {
      if (!(err instanceof HttpError)) log.error?.(err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(res, status, {
        error: err instanceof HttpError ? err.code : 'internal',
        message: err instanceof HttpError ? err.message : 'Greška na serveru.',
      });
      if (status === 413) req.resume();
    }
  }

  const STATIC_TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm',
  };

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (!fs.existsSync(path.join(publicDir, 'index.html'))) return false;
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const abs = path.normalize(path.join(publicDir, rel));
    if (!abs.startsWith(publicDir + path.sep)) return false;
    if (!fs.existsSync(abs)) return false;
    const body = await fs.promises.readFile(abs);
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  // Označi javne rute (bez prijave).
  for (const route of r.routes) {
    if (['/api/health', '/api/server-info', '/api/auth/register', '/api/auth/login', '/api/livekit/webhook']
      .some((p) => route.regex.test(p))) {
      route.handler.public = true;
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  const upgraded = new Set();
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    if (isRtcPath(req.url)) {
      proxyUpgrade(req, socket, head, config.livekit.internalUrl, clientIp(req, config.trustProxy));
    } else {
      socket.destroy();
    }
  });
  server.requestTimeout = 0; // veliki uploadi
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  const timers = [];
  function start() {
    return new Promise((resolve) => {
      server.listen(config.port, config.host, () => {
        timers.push(setInterval(syncVoice, 15_000));
        timers.push(setInterval(cleanupOrphans, 3600_000));
        timers.forEach((t) => t.unref());
        syncVoice();
        cleanupOrphans();
        resolve(server.address());
      });
    });
  }

  async function stop() {
    timers.forEach(clearInterval);
    hub.close();
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    for (const s of upgraded) s.destroy();
    await closed;
    db.close();
  }

  return { server, db, hub, livekit, start, stop, syncVoice };
}
