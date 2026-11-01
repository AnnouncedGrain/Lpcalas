import { useEffect, useState } from 'react';
import { useApp, useClient } from '../lib/context';
import { formatDuration, formatTime } from '../lib/format';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

export function MemberList() {
  const client = useClient();
  const users = useApp((s) => s.users);
  const online = useApp((s) => s.online);
  const voice = useApp((s) => s.voice);
  const channels = useApp((s) => s.channels);
  const meId = useApp((s) => s.me.id);
  const [menu, setMenu] = useState<number | null>(null);
  const onlineSince = useApp((s) => s.onlineSince);
  const activity = useApp((s) => s.activity);
  const [, setTick] = useState(0);

  // Osvježi "online X min" svakih 30 s.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (menu === null) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const inVoice = new Map<number, string>();
  for (const [cid, members] of Object.entries(voice)) {
    const name = channels.find((c) => c.id === Number(cid))?.name || '';
    for (const m of members) inVoice.set(m.userId, m.streaming ? `Streama u ${name}` : `U kanalu ${name}`);
  }

  const all = Object.values(users).filter((u) => !u.disabled);
  const on = all.filter((u) => online.includes(u.id)).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const off = all.filter((u) => !online.includes(u.id)).sort((a, b) => a.displayName.localeCompare(b.displayName));

  const row = (u: (typeof all)[number], isOnline: boolean) => (
    <div
      key={u.id}
      className={`member ${isOnline ? '' : 'offline'}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(u.id === meId || !isOnline ? null : u.id);
      }}
      title={
        isOnline
          ? `Online ${onlineSince[u.id] ? formatDuration(Date.now() - onlineSince[u.id]) : ''}${u.id === meId ? '' : '\nDesni klik: Poke'}`
          : undefined
      }
    >
      <Avatar user={u} size={32} baseUrl={client.api.baseUrl} online={isOnline} />
      <div className="member-text">
        <span className="member-name">
          {u.displayName}
          {u.role === 'admin' && <Icon name="shield" size={12} className="admin-badge" />}
        </span>
        {inVoice.get(u.id) && <span className="muted small">{inVoice.get(u.id)}</span>}
      </div>
      {menu === u.id && (
        <div className="member-menu right" onClick={(e) => e.stopPropagation()}>
          <button className="small" onClick={() => { setMenu(null); client.openPoke(u.id); }}>
            <Icon name="bell" size={14} /> Poke
          </button>
        </div>
      )}
    </div>
  );

  return (
    <aside className="member-list">
      <div className="member-scroll">
        <div className="section-title"><span>Online — {on.length}</span></div>
        {on.map((u) => row(u, true))}
        {off.length > 0 && <div className="section-title"><span>Offline — {off.length}</span></div>}
        {off.map((u) => row(u, false))}
      </div>
      <div className="activity-log">
        <div className="section-title"><span>Aktivnost</span></div>
        <div className="activity-scroll">
          {activity.length === 0 && <div className="muted small activity-empty">Još nema aktivnosti.</div>}
          {[...activity].reverse().slice(0, 50).map((a, i) => (
            <div key={`${a.at}-${a.userId}-${i}`} className={`activity-row ${a.type}`}>
              <span className="activity-time">{formatTime(a.at)}</span>
              <span className="activity-dot" />
              <span className="activity-text">
                <b>{users[a.userId]?.displayName || '?'}</b> {a.type === 'join' ? 'ušao' : 'izašao'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
