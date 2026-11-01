import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type ClipboardEvent, type DragEvent, type KeyboardEvent,
} from 'react';
import { useApp, useClient } from '../lib/context';
import { formatDay, formatSize, formatTime, isOnlyEmoji, renderMarkdown } from '../lib/format';
import type { Attachment, Message } from '../lib/types';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { openExternal } from '../lib/native';

const QUICK_EMOJI = ['👍', '😂', '❤️', '🔥', '😮', '😢', '👀', '💀', '🎉', 'GG'];
const GROUP_MS = 5 * 60 * 1000;

interface PendingUpload {
  localId: number;
  file: File;
  progress: number;
  attachment?: Attachment;
  error?: string;
  previewUrl?: string;
}

export function ChatView({ channelId }: { channelId: number }) {
  const client = useClient();
  const channel = useApp((s) => s.channels.find((c) => c.id === channelId));
  const data = useApp((s) => s.messages[channelId]);
  const me = useApp((s) => s.me);
  const typing = useApp((s) => s.typing[channelId]);
  const users = useApp((s) => s.users);
  const maxUpload = useApp((s) => s.maxUploadBytes);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef<{ height: number; firstId: number | null }>({ height: 0, firstId: null });
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [dragging, setDragging] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);

  const items = data?.items || [];

  // Zadrži poziciju pri učitavanju starijih poruka, inače skroluj na dno ako je korisnik bio dolje.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firstId = items[0]?.id ?? null;
    if (prevHeight.current.firstId !== null && firstId !== prevHeight.current.firstId && el.scrollTop < 200) {
      el.scrollTop = el.scrollHeight - prevHeight.current.height + el.scrollTop;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevHeight.current = { height: el.scrollHeight, firstId };
  }, [items]);

  useEffect(() => {
    atBottom.current = true;
    setReplyTo(null);
    setEditing(null);
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    client.markRead(channelId);
  }, [channelId, client]);

  useEffect(() => {
    const onFocus = () => client.markRead(channelId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [channelId, client]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current) client.markRead(channelId);
    if (el.scrollTop < 300 && data?.hasMore && !data.loadingOlder) void client.loadOlder(channelId);
  }

  const typingNames = useMemo(
    () => Object.keys(typing || {}).map((id) => users[Number(id)]?.displayName).filter(Boolean),
    [typing, users],
  );

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length) composerRef.current?.addFiles(files);
  }

  return (
    <section
      className="chat"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="chat-header">
        <Icon name="hash" size={22} className="muted" />
        <h2>{channel?.name}</h2>
      </header>

      <div className="messages" ref={scrollRef} onScroll={onScroll}>
        {data?.loadingOlder && <div className="loading-older">Učitavam starije poruke...</div>}
        {data && !data.hasMore && (
          <div className="channel-start">
            <div className="channel-start-icon"><Icon name="hash" size={36} /></div>
            <h3>Dobro došli u #{channel?.name}</h3>
            <p className="muted">Ovo je početak kanala.</p>
          </div>
        )}
        {!data && <div className="loading-older">Učitavam...</div>}
        {items.map((m, i) => {
          const prev = items[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const grouped = !newDay && prev && prev.userId === m.userId && m.createdAt - prev.createdAt < GROUP_MS && !m.replyTo;
          return (
            <MessageRow
              key={m.id}
              message={m}
              grouped={!!grouped}
              newDay={newDay}
              isMine={m.userId === me.id}
              canDelete={m.userId === me.id || me.role === 'admin'}
              onReply={() => {
                setReplyTo(m);
                setEditing(null);
                composerRef.current?.focus();
              }}
              onEdit={() => {
                setEditing(m);
                setReplyTo(null);
              }}
              editing={editing?.id === m.id}
              onEditDone={() => setEditing(null)}
              onOpenImage={setLightbox}
            />
          );
        })}
      </div>

      <div className="typing-line">
        {typingNames.length > 0 && (
          <span>
            <span className="typing-dots"><i /><i /><i /></span>
            <b>{typingNames.slice(0, 3).join(', ')}</b> {typingNames.length === 1 ? 'kuca...' : 'kucaju...'}
          </span>
        )}
      </div>

      <Composer
        ref={composerRef}
        channelId={channelId}
        channelName={channel?.name || ''}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        maxUpload={maxUpload}
        onEditLast={() => {
          const mine = [...items].reverse().find((m) => m.userId === me.id);
          if (mine) setEditing(mine);
        }}
        onSent={() => {
          atBottom.current = true;
          setReplyTo(null);
        }}
      />

      {dragging && (
        <div className="drop-overlay">
          <div>
            <Icon name="paperclip" size={40} />
            <p>Pusti fajlove da ih pošalješ u #{channel?.name}</p>
          </div>
        </div>
      )}
      {lightbox && <Lightbox attachment={lightbox} baseUrl={client.api.baseUrl} onClose={() => setLightbox(null)} />}
    </section>
  );
}

// ---------------- Poruka ----------------

function MessageRow({
  message: m,
  grouped,
  newDay,
  isMine,
  canDelete,
  onReply,
  onEdit,
  editing,
  onEditDone,
  onOpenImage,
}: {
  message: Message;
  grouped: boolean;
  newDay: boolean;
  isMine: boolean;
  canDelete: boolean;
  onReply: () => void;
  onEdit: () => void;
  editing: boolean;
  onEditDone: () => void;
  onOpenImage: (a: Attachment) => void;
}) {
  const client = useClient();
  const author = useApp((s) => s.users[m.userId]);
  const users = useApp((s) => s.users);
  const meId = useApp((s) => s.me.id);
  const [picker, setPicker] = useState(false);
  const base = client.api.baseUrl;
  const bigEmoji = isOnlyEmoji(m.content) && m.attachments.length === 0;

  async function toggleReaction(emoji: string) {
    const mine = m.reactions.find((r) => r.emoji === emoji)?.userIds.includes(meId);
    setPicker(false);
    await client.api.react(m.id, emoji, !mine).catch((e) => alert(e.message));
  }

  async function remove() {
    if (!confirm('Obrisati ovu poruku?')) return;
    await client.api.deleteMessage(m.id).catch((e) => alert(e.message));
  }

  return (
    <>
      {newDay && (
        <div className="day-divider">
          <span>{formatDay(m.createdAt)}</span>
        </div>
      )}
      <div className={`message ${grouped ? 'grouped' : ''}`}>
        {m.replyTo && (
          <div className="reply-preview">
            <span className="reply-line" />
            {m.replyTo.deleted ? (
              <i className="muted">Originalna poruka je obrisana</i>
            ) : (
              <>
                <b>{users[m.replyTo.userId ?? 0]?.displayName || '?'}</b>
                <span className="muted">{m.replyTo.content || '(prilog)'}</span>
              </>
            )}
          </div>
        )}
        <div className="message-body">
          <div className="message-gutter">
            {grouped ? (
              <span className="hover-time">{formatTime(m.createdAt)}</span>
            ) : (
              <Avatar user={author} size={40} baseUrl={base} />
            )}
          </div>
          <div className="message-main">
            {!grouped && (
              <div className="message-head">
                <span className="author">{author?.displayName || 'Nepoznat'}</span>
                {author?.role === 'admin' && <Icon name="shield" size={13} className="admin-badge" title="Admin" />}
                <span className="time">{formatDay(m.createdAt)} u {formatTime(m.createdAt)}</span>
              </div>
            )}
            {editing ? (
              <EditBox message={m} onDone={onEditDone} />
            ) : (
              m.content && (
                <div className={`message-content ${bigEmoji ? 'big-emoji' : ''}`}>
                  {renderMarkdown(m.content)}
                  {m.editedAt && <span className="edited"> (uređeno)</span>}
                </div>
              )
            )}
            {m.attachments.length > 0 && (
              <div className="attachments">
                {m.attachments.map((a) => (
                  <AttachmentView key={a.id} a={a} base={base} onOpenImage={onOpenImage} />
                ))}
              </div>
            )}
            {m.reactions.length > 0 && (
              <div className="reactions">
                {m.reactions.map((r) => (
                  <button
                    key={r.emoji}
                    className={`reaction ${r.userIds.includes(meId) ? 'mine' : ''}`}
                    onClick={() => toggleReaction(r.emoji)}
                    title={r.userIds.map((id) => users[id]?.displayName || '?').join(', ')}
                  >
                    <span>{r.emoji}</span> <span>{r.userIds.length}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="message-actions">
          <button className="icon-btn small" title="Reakcija" onClick={() => setPicker((x) => !x)}>
            <Icon name="smile" size={16} />
          </button>
          <button className="icon-btn small" title="Odgovori" onClick={onReply}>
            <Icon name="reply" size={16} />
          </button>
          {isMine && (
            <button className="icon-btn small" title="Uredi" onClick={onEdit}>
              <Icon name="edit" size={16} />
            </button>
          )}
          {canDelete && (
            <button className="icon-btn small danger" title="Obriši" onClick={remove}>
              <Icon name="trash" size={16} />
            </button>
          )}
          {picker && (
            <div className="emoji-picker" onMouseLeave={() => setPicker(false)}>
              {QUICK_EMOJI.map((e) => (
                <button key={e} onClick={() => toggleReaction(e)}>{e}</button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function AttachmentView({ a, base, onOpenImage }: { a: Attachment; base: string; onOpenImage: (a: Attachment) => void }) {
  const src = base + a.url;
  const box = fitBox(a.width, a.height, 420, 320);
  if (a.mime.startsWith('image/')) {
    return (
      <img
        className="att-image"
        src={src}
        alt={a.filename}
        loading="lazy"
        style={box}
        onClick={() => onOpenImage(a)}
        draggable={false}
      />
    );
  }
  if (a.mime.startsWith('video/')) {
    return <video className="att-video" src={src} controls preload="metadata" style={fitBox(a.width, a.height, 520, 360)} />;
  }
  if (a.mime.startsWith('audio/')) {
    return (
      <div className="att-file">
        <div className="att-file-name">{a.filename}</div>
        <audio src={src} controls preload="none" />
      </div>
    );
  }
  return (
    <div className="att-file">
      <Icon name="file" size={28} />
      <div>
        <div className="att-file-name">{a.filename}</div>
        <div className="muted small">{formatSize(a.size)}</div>
      </div>
      <button className="icon-btn" title="Preuzmi" onClick={() => void openExternal(src)}>
        <Icon name="download" size={18} />
      </button>
    </div>
  );
}

function fitBox(w: number | null, h: number | null, maxW: number, maxH: number) {
  if (!w || !h) return { maxWidth: maxW, maxHeight: maxH };
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

function EditBox({ message, onDone }: { message: Message; onDone: () => void }) {
  const client = useClient();
  const [value, setValue] = useState(message.content);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);
  async function save() {
    if (value.trim() === message.content.trim()) return onDone();
    try {
      await client.api.editMessage(message.id, value);
      onDone();
    } catch (e: any) {
      alert(e.message);
    }
  }
  return (
    <div className="edit-box">
      <textarea
        ref={ref}
        value={value}
        rows={Math.min(8, value.split('\n').length)}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="muted small">Escape za odustani · Enter za sačuvaj</div>
    </div>
  );
}

function Lightbox({ attachment, baseUrl, onClose }: { attachment: Attachment; baseUrl: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const src = baseUrl + attachment.url;
  return (
    <div className="lightbox" onClick={onClose}>
      <img src={src} alt={attachment.filename} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span>{attachment.filename}</span>
        <button className="link" onClick={() => void openExternal(src)}>Otvori original</button>
      </div>
    </div>
  );
}

// ---------------- Pisanje poruke ----------------

interface ComposerHandle {
  addFiles: (files: File[]) => void;
  focus: () => void;
}

let nextLocalId = 1;

const Composer = forwardRef<ComposerHandle, {
  channelId: number;
  channelName: string;
  replyTo: Message | null;
  onCancelReply: () => void;
  maxUpload: number;
  onEditLast: () => void;
  onSent: () => void;
}>(function Composer({ channelId, channelName, replyTo, onCancelReply, maxUpload, onEditLast, onSent }, ref) {
  const client = useClient();
  const users = useApp((s) => s.users);
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const drafts = useRef<Record<number, string>>({});

  useEffect(() => {
    setText(drafts.current[channelId] || '');
    setUploads([]);
    setError(null);
    textRef.current?.focus();
  }, [channelId]);

  useEffect(() => {
    drafts.current[channelId] = text;
  }, [text, channelId]);

  // Automatska visina polja
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [text]);

  const addFiles = useCallback(
    (files: File[]) => {
      for (const file of files.slice(0, 10)) {
        if (file.size > maxUpload) {
          setError(`"${file.name}" je prevelik (max ${formatSize(maxUpload)}).`);
          continue;
        }
        const localId = nextLocalId++;
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        setUploads((u) => [...u, { localId, file, progress: 0, previewUrl }]);
        void (async () => {
          try {
            const dims = await mediaDimensions(file);
            const name = file.name && file.name !== 'image.png' ? file.name : `slika-${Date.now()}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
            const attachment = await client.api.upload(file, name, (p) =>
              setUploads((u) => u.map((x) => (x.localId === localId ? { ...x, progress: p } : x))),
            dims || undefined);
            setUploads((u) => u.map((x) => (x.localId === localId ? { ...x, progress: 1, attachment } : x)));
          } catch (e: any) {
            setUploads((u) => u.map((x) => (x.localId === localId ? { ...x, error: e.message } : x)));
          }
        })();
      }
    },
    [client, maxUpload],
  );

  useImperativeHandle(ref, () => ({ addFiles, focus: () => textRef.current?.focus() }), [addFiles]);

  const uploading = uploads.some((u) => !u.attachment && !u.error);

  async function send() {
    const content = text.trim();
    const ready = uploads.filter((u) => u.attachment);
    if ((!content && ready.length === 0) || sending || uploading) return;
    setSending(true);
    setError(null);
    try {
      await client.sendMessage(channelId, content, ready.map((u) => u.attachment!.id), replyTo?.id);
      uploads.forEach((u) => u.previewUrl && URL.revokeObjectURL(u.previewUrl));
      setText('');
      setUploads([]);
      onSent();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
      textRef.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    } else if (e.key === 'ArrowUp' && !text) {
      e.preventDefault();
      onEditLast();
    } else if (e.key === 'Escape') {
      onCancelReply();
    }
  }

  function onPaste(e: ClipboardEvent) {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  }

  return (
    <div className="composer-wrap">
      {replyTo && (
        <div className="composer-reply">
          <span>
            Odgovaraš korisniku <b>{users[replyTo.userId]?.displayName}</b>
          </span>
          <button className="icon-btn small" onClick={onCancelReply} title="Otkaži">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {uploads.length > 0 && (
        <div className="upload-list">
          {uploads.map((u) => (
            <div key={u.localId} className={`upload-item ${u.error ? 'failed' : ''}`}>
              {u.previewUrl ? <img src={u.previewUrl} alt="" /> : <Icon name="file" size={32} />}
              <span className="upload-name" title={u.file.name}>{u.file.name || 'slika'}</span>
              <span className="muted small">{u.error ? u.error : u.attachment ? formatSize(u.file.size) : `${Math.round(u.progress * 100)}%`}</span>
              {!u.attachment && !u.error && <span className="progress" style={{ width: `${u.progress * 100}%` }} />}
              <button
                className="icon-btn small remove"
                title="Ukloni"
                onClick={() => setUploads((list) => list.filter((x) => x.localId !== u.localId))}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="composer-error" onClick={() => setError(null)}>{error}</div>}
      <div className="composer">
        <button className="icon-btn" title="Pošalji fajl (slike, video...)" onClick={() => fileRef.current?.click()}>
          <Icon name="plus" size={20} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files || [])]);
            e.target.value = '';
          }}
        />
        <textarea
          ref={textRef}
          value={text}
          rows={1}
          placeholder={`Poruka u #${channelName}`}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value) client.notifyTyping(channelId);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          maxLength={4000}
        />
        <button className="send-btn" onClick={() => void send()} disabled={sending || uploading || (!text.trim() && !uploads.some((u) => u.attachment))}>
          {uploading ? 'Šaljem fajl...' : 'Pošalji'}
        </button>
      </div>
    </div>
  );
});

async function mediaDimensions(file: File): Promise<{ width: number; height: number } | null> {
  try {
    if (file.type.startsWith('image/') && file.type !== 'image/gif') {
      const bmp = await createImageBitmap(file);
      const d = { width: bmp.width, height: bmp.height };
      bmp.close();
      return d;
    }
    if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
      const url = URL.createObjectURL(file);
      try {
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 3000);
          if (file.type.startsWith('video/')) {
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.onloadedmetadata = () => {
              clearTimeout(timer);
              resolve(v.videoWidth ? { width: v.videoWidth, height: v.videoHeight } : null);
            };
            v.onerror = () => resolve(null);
            v.src = url;
          } else {
            const img = new Image();
            img.onload = () => {
              clearTimeout(timer);
              resolve({ width: img.naturalWidth, height: img.naturalHeight });
            };
            img.onerror = () => resolve(null);
            img.src = url;
          }
        });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    }
  } catch {
    /* bez dimenzija */
  }
  return null;
}
