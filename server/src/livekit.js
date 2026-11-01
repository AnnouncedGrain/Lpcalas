import crypto from 'node:crypto';
import { signJwt, verifyJwt } from './security.js';

export const roomName = (channelId) => `voice-${channelId}`;

export function channelIdFromRoom(name) {
  const m = /^voice-(\d+)$/.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}

export class LiveKit {
  constructor({ apiKey, apiSecret, internalUrl }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.internalUrl = internalUrl;
  }

  get configured() {
    return Boolean(this.apiKey && this.apiSecret);
  }

  // Token za ulazak u glasovni kanal.
  joinToken({ identity, name, room, metadata, ttlSeconds = 6 * 3600 }) {
    const now = Math.floor(Date.now() / 1000);
    return signJwt(
      {
        iss: this.apiKey,
        sub: identity,
        name,
        nbf: now - 10,
        exp: now + ttlSeconds,
        metadata: metadata ? JSON.stringify(metadata) : undefined,
        video: {
          room,
          roomJoin: true,
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
          canUpdateOwnMetadata: true,
        },
      },
      this.apiSecret,
    );
  }

  adminToken(video) {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({ iss: this.apiKey, sub: 'lpcalas-backend', nbf: now - 10, exp: now + 300, video }, this.apiSecret);
  }

  // LiveKit šalje webhook s JWT-om u Authorization headeru i sha256 tijela u claimu.
  verifyWebhook(rawBody, authHeader) {
    if (!this.configured) return null;
    const token = String(authHeader || '').replace(/^Bearer\s+/i, '');
    const claims = verifyJwt(token, this.apiSecret);
    if (!claims || claims.iss !== this.apiKey) return null;
    const digest = crypto.createHash('sha256').update(rawBody).digest('base64');
    if (claims.sha256 !== digest) return null;
    try {
      return JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
  }

  async twirp(method, body, video) {
    const res = await fetch(`${this.internalUrl}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.adminToken(video)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`LiveKit ${method}: HTTP ${res.status}`);
    return res.json();
  }

  async listRooms() {
    const data = await this.twirp('ListRooms', {}, { roomList: true });
    return data.rooms || [];
  }

  async listParticipants(room) {
    const data = await this.twirp('ListParticipants', { room }, { roomAdmin: true, room });
    return data.participants || [];
  }

  async removeParticipant(room, identity) {
    await this.twirp('RemoveParticipant', { room, identity }, { roomAdmin: true, room });
  }
}
