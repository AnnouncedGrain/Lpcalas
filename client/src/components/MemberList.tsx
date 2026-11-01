import { useApp, useClient } from '../lib/context';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

export function MemberList() {
  const client = useClient();
  const users = useApp((s) => s.users);
  const online = useApp((s) => s.online);
  const voice = useApp((s) => s.voice);
  const channels = useApp((s) => s.channels);

  const inVoice = new Map<number, string>();
  for (const [cid, members] of Object.entries(voice)) {
    const name = channels.find((c) => c.id === Number(cid))?.name || '';
    for (const m of members) inVoice.set(m.userId, m.streaming ? `Streama u ${name}` : `U kanalu ${name}`);
  }

  const all = Object.values(users).filter((u) => !u.disabled);
  const on = all.filter((u) => online.includes(u.id)).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const off = all.filter((u) => !online.includes(u.id)).sort((a, b) => a.displayName.localeCompare(b.displayName));

  const row = (u: (typeof all)[number], isOnline: boolean) => (
    <div key={u.id} className={`member ${isOnline ? '' : 'offline'}`}>
      <Avatar user={u} size={32} baseUrl={client.api.baseUrl} online={isOnline} />
      <div className="member-text">
        <span className="member-name">
          {u.displayName}
          {u.role === 'admin' && <Icon name="shield" size={12} className="admin-badge" />}
        </span>
        {inVoice.get(u.id) && <span className="muted small">{inVoice.get(u.id)}</span>}
      </div>
    </div>
  );

  return (
    <aside className="member-list">
      <div className="section-title"><span>Online — {on.length}</span></div>
      {on.map((u) => row(u, true))}
      {off.length > 0 && <div className="section-title"><span>Offline — {off.length}</span></div>}
      {off.map((u) => row(u, false))}
    </aside>
  );
}
