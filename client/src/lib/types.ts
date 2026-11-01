export interface User {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  avatarUrl: string | null;
  disabled: boolean;
  bot?: boolean;
  createdAt: number;
}

export interface Channel {
  id: number;
  name: string;
  type: 'text' | 'voice';
  position: number;
  readonly?: boolean;
}

export interface Attachment {
  id: number;
  url: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
}

export interface Reaction {
  emoji: string;
  userIds: number[];
}

export interface Message {
  id: number;
  channelId: number;
  userId: number;
  content: string;
  replyTo: { id: number; userId?: number; content?: string; deleted?: boolean } | null;
  createdAt: number;
  editedAt: number | null;
  attachments: Attachment[];
  reactions: Reaction[];
}

export interface VoiceMember {
  userId: number;
  joinedAt: number;
  muted: boolean;
  deafened: boolean;
  streaming: boolean;
}

export type VoiceMap = Record<string, VoiceMember[]>;

export interface Bootstrap {
  me: User;
  server: { name: string; version: string; maxUploadBytes: number; voiceEnabled: boolean; uploadMbps?: number };
  users: User[];
  channels: Channel[];
  online: number[];
  voice: VoiceMap;
}

export interface Invite {
  code: string;
  usesLeft: number | null;
  expiresAt: number | null;
  createdAt: number;
}
