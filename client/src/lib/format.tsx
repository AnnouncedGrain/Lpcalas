import type { ReactNode } from 'react';
import { openExternal } from './native';

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('bs-BA', { hour: '2-digit', minute: '2-digit' });
}

export function formatDay(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Danas';
  if (same(d, yesterday)) return 'Jučer';
  return d.toLocaleDateString('bs-BA', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

const COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#1abc9c'];
export function colorFor(id: number): string {
  return COLORS[Math.abs(id) % COLORS.length];
}

// ---- Jednostavan markdown: **bold**, *italic*, __underline__, ~~strike~~, `code`, ```blok```, linkovi ----

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

function Link({ href }: { href: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void openExternal(href);
      }}
    >
      {href}
    </a>
  );
}

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Prvo inline kod, da unutar njega ništa ne formatiramo.
  const parts = text.split(/(`[^`\n]+`)/g);
  parts.forEach((part, i) => {
    const key = `${keyBase}-${i}`;
    if (/^`[^`\n]+`$/.test(part)) {
      out.push(<code key={key}>{part.slice(1, -1)}</code>);
      return;
    }
    out.push(...emphasis(part, key));
  });
  return out;
}

const EMPH: Array<[RegExp, (children: ReactNode[], key: string) => ReactNode]> = [
  [/\*\*([^*]+)\*\*/, (c, k) => <strong key={k}>{c}</strong>],
  [/__([^_]+)__/, (c, k) => <u key={k}>{c}</u>],
  [/~~([^~]+)~~/, (c, k) => <s key={k}>{c}</s>],
  [/\*([^*\s][^*]*)\*/, (c, k) => <em key={k}>{c}</em>],
  [/\|\|([^|]+)\|\|/, (c, k) => <Spoiler key={k}>{c}</Spoiler>],
];

function emphasis(text: string, key: string): ReactNode[] {
  let best: { idx: number; len: number; inner: string; render: (c: ReactNode[], k: string) => ReactNode } | null = null;
  for (const [re, render] of EMPH) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.idx)) best = { idx: m.index, len: m[0].length, inner: m[1], render };
  }
  if (!best) return links(text, key);
  return [
    ...links(text.slice(0, best.idx), `${key}a`),
    best.render(emphasis(best.inner, `${key}b`), `${key}e`),
    ...emphasis(text.slice(best.idx + best.len), `${key}c`),
  ];
}

function links(text: string, key: string): ReactNode[] {
  if (!text) return [];
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(<Link key={`${key}l${i++}`} href={m[0]} />);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Spoiler({ children }: { children: ReactNode }) {
  return (
    <span className="spoiler" onClick={(e) => (e.currentTarget as HTMLElement).classList.add('revealed')}>
      {children}
    </span>
  );
}

export function renderMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const blocks = text.split(/(```[\s\S]*?```)/g);
  blocks.forEach((block, bi) => {
    if (/^```[\s\S]*```$/.test(block)) {
      const body = block.slice(3, -3).replace(/^[a-zA-Z0-9+-]*\n/, '');
      out.push(<pre key={`b${bi}`}><code>{body.replace(/\n$/, '')}</code></pre>);
      return;
    }
    const lines = block.split('\n');
    lines.forEach((line, li) => {
      if (li > 0) out.push(<br key={`br${bi}-${li}`} />);
      if (line.startsWith('> ')) {
        out.push(<span key={`q${bi}-${li}`} className="quote">{inline(line.slice(2), `q${bi}-${li}`)}</span>);
      } else {
        out.push(...inline(line, `t${bi}-${li}`));
      }
    });
  });
  return out;
}

export function isOnlyEmoji(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 24) return false;
  return /^(\p{Extended_Pictographic}|\p{Emoji_Component}|\s|‍|️)+$/u.test(t) && !/^[\d#*\s]+$/.test(t);
}
