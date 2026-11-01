import { CORS_HEADERS } from './http.js';

// Realtime događaji preko Server-Sent Events + stanje prisutnosti i glasovnih kanala.
export class Hub {
  constructor() {
    this.clients = new Map(); // connId -> { res, userId }
    this.nextId = 1;
    this.offlineTimers = new Map(); // userId -> timeout
    this.onlineSince = new Map(); // userId -> ms
    this.activity = []; // zadnjih 100: { userId, type: 'join' | 'leave', at }
    // Glasovni kanali: channelId -> Map(userId -> { joinedAt })
    this.voice = new Map();
    // Status koji klijent sam prijavi: userId -> { muted, deafened, streaming }
    this.voiceFlags = new Map();
    this.keepalive = setInterval(() => this.ping(), 25000);
    this.keepalive.unref();
  }

  close() {
    clearInterval(this.keepalive);
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    for (const { res } of this.clients.values()) res.end();
    this.clients.clear();
  }

  connect(req, res, userId) {
    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const connId = this.nextId++;
    const wasOnline = this.isOnline(userId);
    this.clients.set(connId, { res, userId });
    const pending = this.offlineTimers.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.offlineTimers.delete(userId);
    } else if (!wasOnline) {
      const at = Date.now();
      this.onlineSince.set(userId, at);
      this.logActivity(userId, 'join', at);
      this.broadcast('presence', { userId, online: true, since: at, at });
    }
    const cleanup = () => {
      if (!this.clients.delete(connId)) return;
      if (!this.isOnline(userId)) {
        // Mala pauza da reconnect ne izazove treptanje statusa.
        const t = setTimeout(() => {
          this.offlineTimers.delete(userId);
          if (!this.isOnline(userId)) {
            const at = Date.now();
            this.onlineSince.delete(userId);
            this.logActivity(userId, 'leave', at);
            this.broadcast('presence', { userId, online: false, at });
          }
        }, 4000);
        t.unref();
        this.offlineTimers.set(userId, t);
      }
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
    return connId;
  }

  isOnline(userId) {
    for (const c of this.clients.values()) if (c.userId === userId) return true;
    return this.offlineTimers.has(userId);
  }

  logActivity(userId, type, at) {
    this.activity.push({ userId, type, at });
    if (this.activity.length > 100) this.activity.splice(0, this.activity.length - 100);
  }

  presenceSnapshot() {
    return { onlineSince: Object.fromEntries(this.onlineSince), activity: this.activity.slice(-50) };
  }

  onlineUserIds() {
    const ids = new Set();
    for (const c of this.clients.values()) ids.add(c.userId);
    for (const id of this.offlineTimers.keys()) ids.add(id);
    return [...ids];
  }

  send(res, type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(type, data, filter) {
    for (const c of this.clients.values()) {
      if (filter && !filter(c.userId)) continue;
      try {
        this.send(c.res, type, data);
      } catch {
        // konekcija se zatvara, cleanup ide preko 'close'
      }
    }
  }

  sendToUser(userId, type, data) {
    this.broadcast(type, data, (uid) => uid === userId);
  }

  disconnectUser(userId) {
    for (const [connId, c] of this.clients) {
      if (c.userId === userId) {
        this.clients.delete(connId);
        c.res.end();
      }
    }
  }

  ping() {
    for (const c of this.clients.values()) {
      try {
        c.res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }
  }

  // ---- Glasovni kanali ----

  voiceSnapshot() {
    const out = {};
    for (const [channelId, members] of this.voice) {
      if (members.size === 0) continue;
      out[channelId] = [...members.entries()].map(([userId, m]) => ({
        userId,
        joinedAt: m.joinedAt,
        ...this.flagsFor(userId),
      }));
    }
    return out;
  }

  flagsFor(userId) {
    return this.voiceFlags.get(userId) || { muted: false, deafened: false, streaming: false };
  }

  channelOf(userId) {
    for (const [channelId, members] of this.voice) if (members.has(userId)) return channelId;
    return null;
  }

  // Postavi korisnika u kanal (null = izašao). Vraća true ako se nešto promijenilo.
  setVoiceChannel(userId, channelId) {
    const current = this.channelOf(userId);
    if (current === channelId) return false;
    if (current !== null) {
      const members = this.voice.get(current);
      members.delete(userId);
      if (members.size === 0) this.voice.delete(current);
    }
    if (channelId !== null) {
      if (!this.voice.has(channelId)) this.voice.set(channelId, new Map());
      this.voice.get(channelId).set(userId, { joinedAt: Date.now() });
    } else {
      this.voiceFlags.delete(userId);
    }
    this.broadcastVoice();
    return true;
  }

  setVoiceFlags(userId, flags) {
    const prev = this.flagsFor(userId);
    const next = {
      muted: Boolean(flags.muted ?? prev.muted),
      deafened: Boolean(flags.deafened ?? prev.deafened),
      streaming: Boolean(flags.streaming ?? prev.streaming),
    };
    if (prev.muted === next.muted && prev.deafened === next.deafened && prev.streaming === next.streaming) return;
    this.voiceFlags.set(userId, next);
    if (this.channelOf(userId) !== null) this.broadcastVoice();
  }

  // Uskladi s onim što LiveKit stvarno kaže (channelId -> Set(userId)).
  reconcileVoice(actual) {
    let changed = false;
    for (const [channelId, members] of [...this.voice]) {
      const real = actual.get(channelId) || new Set();
      for (const userId of [...members.keys()]) {
        if (!real.has(userId)) {
          members.delete(userId);
          this.voiceFlags.delete(userId);
          changed = true;
        }
      }
      if (members.size === 0) this.voice.delete(channelId);
    }
    for (const [channelId, users] of actual) {
      for (const userId of users) {
        if (this.channelOf(userId) !== channelId) {
          const current = this.channelOf(userId);
          if (current !== null) this.voice.get(current)?.delete(userId);
          if (!this.voice.has(channelId)) this.voice.set(channelId, new Map());
          this.voice.get(channelId).set(userId, { joinedAt: Date.now() });
          changed = true;
        }
      }
    }
    for (const [channelId, members] of [...this.voice]) if (members.size === 0) this.voice.delete(channelId);
    if (changed) this.broadcastVoice();
    return changed;
  }

  broadcastVoice() {
    this.broadcast('voice', this.voiceSnapshot());
  }
}
