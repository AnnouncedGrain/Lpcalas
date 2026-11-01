import type { Attachment, Bootstrap, Channel, Invite, Message, User } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code: string) {
    super(message);
  }
}

export function normalizeServerUrl(input: string): string {
  let url = input.trim();
  if (!url) throw new ApiError(0, 'Upiši adresu servera.', 'validation');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');
  try {
    const u = new URL(url);
    // Privremeni hosting: IP adresa ili localhost bez porta -> pretpostavi 8080.
    const isIpOrLocal = u.hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname);
    if (u.protocol === 'http:' && !u.port && isIpOrLocal) u.port = '8080';
    return u.origin;
  } catch {
    throw new ApiError(0, 'Neispravna adresa servera.', 'validation');
  }
}

export class Api {
  constructor(public baseUrl: string, public token: string | null = null) {}

  url(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    return this.baseUrl + path;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'Server nije dostupan. Provjeri adresu i internet vezu.', 'network');
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* nije JSON */
    }
    if (!res.ok) {
      throw new ApiError(res.status, data?.message || `Greška (${res.status})`, data?.error || 'error');
    }
    return data as T;
  }

  get<T>(path: string) { return this.request<T>('GET', path); }
  post<T>(path: string, body?: unknown) { return this.request<T>('POST', path, body ?? {}); }
  patch<T>(path: string, body: unknown) { return this.request<T>('PATCH', path, body); }
  put<T>(path: string) { return this.request<T>('PUT', path); }
  del<T>(path: string) { return this.request<T>('DELETE', path); }

  serverInfo() {
    return this.get<{ name: string; version: string; voiceEnabled: boolean; needsFirstUser: boolean; maxUploadBytes: number }>('/api/server-info');
  }
  login(username: string, password: string) {
    return this.post<{ token: string; user: User }>('/api/auth/login', { username, password });
  }
  register(data: { username: string; password: string; displayName: string; invite: string }) {
    return this.post<{ token: string; user: User }>('/api/auth/register', data);
  }
  logout() { return this.post('/api/auth/logout'); }
  bootstrap() { return this.get<Bootstrap>('/api/bootstrap'); }

  messages(channelId: number, before?: number) {
    const q = before ? `?before=${before}` : '';
    return this.get<{ messages: Message[]; hasMore: boolean }>(`/api/channels/${channelId}/messages${q}`);
  }
  sendMessage(channelId: number, content: string, attachmentIds: number[], replyTo?: number) {
    return this.post<Message>(`/api/channels/${channelId}/messages`, { content, attachmentIds, replyTo });
  }
  editMessage(id: number, content: string) { return this.patch<Message>(`/api/messages/${id}`, { content }); }
  deleteMessage(id: number) { return this.del(`/api/messages/${id}`); }
  react(id: number, emoji: string, add: boolean) {
    const p = `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`;
    return add ? this.put<Message>(p) : this.del<Message>(p);
  }
  typing(channelId: number) { return this.post(`/api/channels/${channelId}/typing`); }

  updateMe(data: { displayName?: string; password?: { current: string; new: string } }) {
    return this.patch<User>('/api/me', data);
  }

  voiceToken(channelId: number) {
    return this.post<{ token: string; url: string; room: string }>('/api/voice/token', { channelId });
  }
  voiceState(state: { channelId?: number | null; muted?: boolean; deafened?: boolean; streaming?: boolean }) {
    return this.post('/api/voice/state', state);
  }
  voiceKick(userId: number) { return this.post('/api/voice/kick', { userId }); }

  createChannel(name: string, type: 'text' | 'voice') { return this.post<Channel>('/api/channels', { name, type }); }
  renameChannel(id: number, name: string) { return this.patch<Channel>(`/api/channels/${id}`, { name }); }
  deleteChannel(id: number) { return this.del(`/api/channels/${id}`); }
  invites() { return this.get<Invite[]>('/api/invites'); }
  createInvite(uses: number, expiresHours: number | null) { return this.post<Invite>('/api/invites', { uses, expiresHours }); }
  deleteInvite(code: string) { return this.del(`/api/invites/${encodeURIComponent(code)}`); }
  updateUser(id: number, data: { role?: 'admin' | 'member'; disabled?: boolean }) { return this.patch<User>(`/api/users/${id}`, data); }

  // Upload sa praćenjem napretka (fetch nema progress za upload, zato XHR).
  upload<T = Attachment>(file: File | Blob, filename: string, onProgress?: (fraction: number) => void, dims?: { width: number; height: number }, path = '/api/uploads') {
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.url(path));
      if (this.token) xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(filename));
      if (dims) {
        xhr.setRequestHeader('X-Width', String(dims.width));
        xhr.setRequestHeader('X-Height', String(dims.height));
      }
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let data: any = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(xhr.status, data?.message || `Upload nije uspio (${xhr.status})`, data?.error || 'upload'));
      };
      xhr.onerror = () => reject(new ApiError(0, 'Upload prekinut — provjeri vezu.', 'network'));
      xhr.send(file);
    });
  }
}
