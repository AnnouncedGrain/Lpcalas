import { Api, ApiError } from './api';
import { Store } from './store';
import type { Bootstrap, Channel, Message, User, VoiceMap } from './types';
import { VoiceManager } from './voice';
import { settings, saveSession, type SavedSession } from './settings';
import { setHotkeys, flashWindow } from './native';
import { sounds } from './sounds';

export interface ChannelMessages {
  items: Message[];
  hasMore: boolean;
  loaded: boolean;
  loadingOlder: boolean;
}

export interface AppState {
  connection: 'online' | 'reconnecting';
  me: User;
  serverName: string;
  maxUploadBytes: number;
  voiceEnabled: boolean;
  users: Record<number, User>;
  channels: Channel[];
  online: number[];
  voice: VoiceMap;
  messages: Record<number, ChannelMessages>;
  typing: Record<number, Record<number, number>>; // channelId -> userId -> expiresAt
  unread: Record<number, number>;
  activeTextChannelId: number | null;
  view: 'text' | 'voice';
  pokeTarget: number | null; // kome pišem poke
  pokes: Array<{ id: number; from: number; message: string; at: number }>; // primljeni
}

// Jedna instanca po prijavi: API, realtime događaji, glas i stanje aplikacije.
export class Client {
  readonly store: Store<AppState>;
  readonly voice: VoiceManager;
  private events: EventSource | null = null;
  private closed = false;
  private lastTypingSent = 0;
  private typingSweep: ReturnType<typeof setInterval>;
  private unsubSettings: () => void;

  constructor(readonly api: Api, boot: Bootstrap, private onLoggedOut: () => void) {
    const textChannels = boot.channels.filter((c) => c.type === 'text');
    this.store = new Store<AppState>({
      connection: 'online',
      ...this.fromBootstrap(boot),
      messages: {},
      typing: {},
      unread: {},
      activeTextChannelId: textChannels[0]?.id ?? null,
      view: 'text',
      pokeTarget: null,
      pokes: [],
    });
    this.voice = new VoiceManager(api);
    this.connectEvents();
    this.typingSweep = setInterval(() => this.sweepTyping(), 2000);
    this.applyHotkeys();
    let prevHotkeys = settings.get().hotkeys;
    this.unsubSettings = settings.subscribe((s) => {
      if (s.hotkeys !== prevHotkeys) {
        prevHotkeys = s.hotkeys;
        this.applyHotkeys();
      }
    });
    const first = this.store.get().activeTextChannelId;
    if (first) void this.loadMessages(first);
  }

  private fromBootstrap(boot: Bootstrap) {
    return {
      me: boot.me,
      serverName: boot.server.name,
      maxUploadBytes: boot.server.maxUploadBytes,
      voiceEnabled: boot.server.voiceEnabled,
      users: Object.fromEntries(boot.users.map((u) => [u.id, u])),
      channels: boot.channels,
      online: boot.online,
      voice: boot.voice,
    };
  }

  async close() {
    this.closed = true;
    this.events?.close();
    clearInterval(this.typingSweep);
    this.unsubSettings();
    await this.voice.leave(false);
  }

  async logout() {
    await this.api.logout().catch(() => {});
    await this.close();
    const session: SavedSession = { serverUrl: this.api.baseUrl, token: null, username: this.store.get().me.username };
    saveSession(session);
    this.onLoggedOut();
  }

  // ---------- realtime ----------

  private connectEvents() {
    if (this.closed) return;
    const es = new EventSource(this.api.url(`/api/events?token=${encodeURIComponent(this.api.token || '')}`));
    this.events = es;
    let opened = false;
    es.addEventListener('hello', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const wasReconnecting = this.store.get().connection === 'reconnecting';
      this.store.set({ connection: 'online', online: data.online, voice: data.voice });
      if (wasReconnecting) void this.resync();
      opened = true;
    });
    es.onerror = () => {
      if (this.closed) return;
      this.store.set({ connection: 'reconnecting' });
      // EventSource se sam ponovo spaja; ako je token nevažeći, provjeri i odjavi.
      if (es.readyState === EventSource.CLOSED || !opened) {
        es.close();
        setTimeout(() => void this.checkAuthThenReconnect(), 3000);
      }
    };
    const on = (type: string, fn: (data: any) => void) =>
      es.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data)));

    on('message', (m: Message) => this.onMessage(m));
    on('message.updated', (m: Message) => this.patchMessage(m));
    on('message.deleted', ({ id, channelId }: { id: number; channelId: number }) => {
      this.store.set((s) => {
        const ch = s.messages[channelId];
        if (!ch) return {};
        return { messages: { ...s.messages, [channelId]: { ...ch, items: ch.items.filter((x) => x.id !== id) } } };
      });
    });
    on('presence', ({ userId, online }: { userId: number; online: boolean }) => {
      this.store.set((s) => ({
        online: online ? [...new Set([...s.online, userId])] : s.online.filter((x) => x !== userId),
      }));
    });
    on('voice', (voice: VoiceMap) => this.store.set({ voice }));
    on('voice.kicked', () => {
      void this.voice.leave(false).then(() => this.voice.store.set({ error: 'Admin te izbacio iz glasovnog kanala.' }));
    });
    on('user', (u: User) => {
      this.store.set((s) => ({ users: { ...s.users, [u.id]: u }, me: s.me.id === u.id ? u : s.me }));
    });
    on('channel', (c: Channel) => {
      this.store.set((s) => {
        const exists = s.channels.some((x) => x.id === c.id);
        const channels = exists ? s.channels.map((x) => (x.id === c.id ? c : x)) : [...s.channels, c];
        channels.sort((a, b) => a.position - b.position || a.id - b.id);
        return { channels };
      });
    });
    on('channel.deleted', ({ id }: { id: number }) => {
      this.store.set((s) => {
        const channels = s.channels.filter((c) => c.id !== id);
        const active = s.activeTextChannelId === id ? channels.find((c) => c.type === 'text')?.id ?? null : s.activeTextChannelId;
        return { channels, activeTextChannelId: active };
      });
      if (this.voice.store.get().channelId === id) void this.voice.leave();
    });
    on('poke', (p: { from: number; message: string; at: number }) => {
      sounds.poke();
      void flashWindow(true);
      this.store.set((s) => ({ pokes: [...s.pokes, { ...p, id: Date.now() + Math.random() }].slice(-5) }));
    });
    on('typing', ({ channelId, userId }: { channelId: number; userId: number }) => {
      this.store.set((s) => ({
        typing: { ...s.typing, [channelId]: { ...(s.typing[channelId] || {}), [userId]: Date.now() + 6000 } },
      }));
    });
  }

  private async checkAuthThenReconnect() {
    if (this.closed) return;
    try {
      await this.api.bootstrap();
      this.connectEvents();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await this.close();
        saveSession({ serverUrl: this.api.baseUrl, token: null });
        this.onLoggedOut();
        return;
      }
      setTimeout(() => void this.checkAuthThenReconnect(), 5000);
    }
  }

  private async resync() {
    try {
      const boot = await this.api.bootstrap();
      this.store.set({ ...this.fromBootstrap(boot), messages: {} });
      const active = this.store.get().activeTextChannelId;
      if (active) await this.loadMessages(active);
    } catch {
      /* sljedeći reconnect */
    }
  }

  private onMessage(m: Message) {
    const s = this.store.get();
    const ch = s.messages[m.channelId];
    if (ch?.loaded && !ch.items.some((x) => x.id === m.id)) {
      this.store.set((st) => ({
        messages: { ...st.messages, [m.channelId]: { ...ch, items: [...ch.items, m] } },
      }));
    }
    // Ukloni "kuca..." za pošiljaoca
    if (s.typing[m.channelId]?.[m.userId]) {
      this.store.set((st) => {
        const t = { ...(st.typing[m.channelId] || {}) };
        delete t[m.userId];
        return { typing: { ...st.typing, [m.channelId]: t } };
      });
    }
    if (m.userId !== s.me.id) {
      const visible = s.view === 'text' && s.activeTextChannelId === m.channelId && document.hasFocus();
      if (settings.get().messageSounds) sounds.message();
      if (!visible) {
        this.store.set((st) => ({ unread: { ...st.unread, [m.channelId]: (st.unread[m.channelId] || 0) + 1 } }));
        void flashWindow();
      }
    }
  }

  private patchMessage(m: Message) {
    this.store.set((s) => {
      const ch = s.messages[m.channelId];
      if (!ch) return {};
      return { messages: { ...s.messages, [m.channelId]: { ...ch, items: ch.items.map((x) => (x.id === m.id ? m : x)) } } };
    });
  }

  private sweepTyping() {
    const now = Date.now();
    const { typing } = this.store.get();
    let changed = false;
    const next: AppState['typing'] = {};
    for (const [cid, users] of Object.entries(typing)) {
      const kept: Record<number, number> = {};
      for (const [uid, exp] of Object.entries(users)) {
        if (exp > now) kept[Number(uid)] = exp;
        else changed = true;
      }
      next[Number(cid)] = kept;
    }
    if (changed) this.store.set({ typing: next });
  }

  // ---------- navigacija ----------

  openTextChannel(channelId: number) {
    this.store.set((s) => ({ activeTextChannelId: channelId, view: 'text', unread: { ...s.unread, [channelId]: 0 } }));
    const ch = this.store.get().messages[channelId];
    if (!ch?.loaded) void this.loadMessages(channelId);
  }

  async openVoiceChannel(channelId: number) {
    this.store.set({ view: 'voice' });
    if (this.voice.store.get().channelId !== channelId) await this.voice.join(channelId);
  }

  showVoiceView() {
    this.store.set({ view: 'voice' });
  }

  markRead(channelId: number) {
    if (this.store.get().unread[channelId]) {
      this.store.set((s) => ({ unread: { ...s.unread, [channelId]: 0 } }));
    }
  }

  // ---------- poruke ----------

  async loadMessages(channelId: number) {
    const { messages } = await this.api.messages(channelId).catch(() => ({ messages: null as Message[] | null, hasMore: false }));
    if (!messages) return;
    const hasMore = messages.length >= 50;
    this.store.set((s) => ({
      messages: { ...s.messages, [channelId]: { items: messages, hasMore, loaded: true, loadingOlder: false } },
    }));
  }

  async loadOlder(channelId: number) {
    const ch = this.store.get().messages[channelId];
    if (!ch || !ch.hasMore || ch.loadingOlder || ch.items.length === 0) return;
    this.store.set((s) => ({ messages: { ...s.messages, [channelId]: { ...ch, loadingOlder: true } } }));
    try {
      const res = await this.api.messages(channelId, ch.items[0].id);
      this.store.set((s) => {
        const cur = s.messages[channelId];
        const known = new Set(cur.items.map((m) => m.id));
        const older = res.messages.filter((m) => !known.has(m.id));
        return { messages: { ...s.messages, [channelId]: { ...cur, items: [...older, ...cur.items], hasMore: res.hasMore, loadingOlder: false } } };
      });
    } catch {
      this.store.set((s) => ({ messages: { ...s.messages, [channelId]: { ...s.messages[channelId], loadingOlder: false } } }));
    }
  }

  async sendMessage(channelId: number, content: string, attachmentIds: number[], replyTo?: number) {
    const m = await this.api.sendMessage(channelId, content, attachmentIds, replyTo);
    this.onMessage(m);
    this.lastTypingSent = 0;
    return m;
  }

  notifyTyping(channelId: number) {
    const now = Date.now();
    if (now - this.lastTypingSent < 4000) return;
    this.lastTypingSent = now;
    void this.api.typing(channelId).catch(() => {});
  }

  // ---------- poke ----------

  openPoke(userId: number | null) {
    this.store.set({ pokeTarget: userId });
  }

  async sendPoke(userId: number, message: string) {
    const r = await this.api.poke(userId, message);
    return r.delivered;
  }

  dismissPoke(id: number) {
    this.store.set((s) => ({ pokes: s.pokes.filter((p) => p.id !== id) }));
  }

  // ---------- tipke ----------

  private applyHotkeys() {
    const { hotkeys } = settings.get();
    void setHotkeys(hotkeys, (action, pressed) => {
      if (action === 'ptt') this.voice.setPtt(pressed);
      else if (action === 'toggleMute' && pressed) this.voice.toggleMute();
      else if (action === 'toggleDeafen' && pressed) this.voice.toggleDeafen();
    }).catch(() => {});
  }
}
