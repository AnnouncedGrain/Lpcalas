import { useEffect, useState, type MouseEvent } from 'react';
import { useApp, useClient, useSettings, useVoice } from '../lib/context';
import { settings } from '../lib/settings';
import type { Channel, VoiceMember } from '../lib/types';
import { formatDuration } from '../lib/format';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const client = useClient();
  const serverName = useApp((s) => s.serverName);
  const channels = useApp((s) => s.channels);
  const me = useApp((s) => s.me);
  const view = useApp((s) => s.view);
  const activeText = useApp((s) => s.activeTextChannelId);
  const unread = useApp((s) => s.unread);
  const voice = useApp((s) => s.voice);
  const connection = useApp((s) => s.connection);
  const myVoiceChannel = useVoice((v) => v.channelId);
  const [openMenu, setOpenMenu] = useState<number | null>(null);

  // Klik bilo gdje drugo ili Escape zatvara otvoreni meni.
  useEffect(() => {
    if (openMenu === null) return;
    const close = () => setOpenMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const text = channels.filter((c) => c.type === 'text');
  const voiceChannels = channels.filter((c) => c.type === 'voice');
  const isAdmin = me.role === 'admin';

  async function addChannel(type: 'text' | 'voice') {
    const name = prompt(type === 'text' ? 'Naziv novog tekstualnog kanala:' : 'Naziv novog glasovnog kanala:');
    if (!name?.trim()) return;
    try {
      await client.api.createChannel(name.trim(), type);
    } catch (e: any) {
      alert(e.message);
    }
  }

  return (
    <aside className="sidebar">
      <header className="server-header">
        <span className="server-name">{serverName}</span>
        {connection === 'reconnecting' && <span className="pill warn" title="Veza sa serverom je prekinuta, ponovo se spajam">Spajam...</span>}
      </header>

      <div className="channel-scroll">
        <div className="section-title">
          <span>Tekstualni kanali</span>
          {isAdmin && (
            <button className="icon-btn small" title="Novi tekstualni kanal" onClick={() => addChannel('text')}>
              <Icon name="plus" size={16} />
            </button>
          )}
        </div>
        {text.map((c) => (
          <button
            key={c.id}
            className={`channel ${view === 'text' && activeText === c.id ? 'active' : ''} ${unread[c.id] ? 'unread' : ''}`}
            onClick={() => client.openTextChannel(c.id)}
            onContextMenu={(e) => isAdmin && channelMenu(e, c)}
          >
            <Icon name="hash" size={18} className="channel-icon" />
            <span className="channel-name">{c.name}</span>
            {unread[c.id] ? <span className="badge">{unread[c.id] > 99 ? '99+' : unread[c.id]}</span> : null}
          </button>
        ))}

        <div className="section-title">
          <span>Glasovni kanali</span>
          {isAdmin && (
            <button className="icon-btn small" title="Novi glasovni kanal" onClick={() => addChannel('voice')}>
              <Icon name="plus" size={16} />
            </button>
          )}
        </div>
        {voiceChannels.map((c) => (
          <div key={c.id} className="voice-channel">
            <button
              className={`channel ${myVoiceChannel === c.id ? 'connected' : ''} ${view === 'voice' && myVoiceChannel === c.id ? 'active' : ''}`}
              onClick={() => (myVoiceChannel === c.id ? client.showVoiceView() : client.openVoiceChannel(c.id))}
              onContextMenu={(e) => isAdmin && channelMenu(e, c)}
              title={myVoiceChannel === c.id ? 'Prikaži kanal' : 'Uđi u kanal'}
            >
              <Icon name="volume" size={18} className="channel-icon" />
              <span className="channel-name">{c.name}</span>
            </button>
            <div className="voice-members">
              {(voice[c.id] || []).map((m) => (
                <VoiceMemberRow
                  key={m.userId}
                  member={m}
                  menuOpen={openMenu === m.userId}
                  onMenu={(open) => setOpenMenu(open ? m.userId : null)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <VoiceStatusPanel />
      <UserPanel onOpenSettings={onOpenSettings} />
    </aside>
  );

  function channelMenu(e: MouseEvent, c: Channel) {
    e.preventDefault();
    const action = prompt(`Kanal "${c.name}"\nUpiši novi naziv, ili OBRISI za brisanje kanala:`, c.name);
    if (!action || action === c.name) return;
    if (action.trim().toUpperCase() === 'OBRISI') {
      if (confirm(`Sigurno obrisati kanal "${c.name}" i sve poruke u njemu?`)) {
        client.api.deleteChannel(c.id).catch((err) => alert(err.message));
      }
    } else {
      client.api.renameChannel(c.id, action.trim()).catch((err) => alert(err.message));
    }
  }
}

function VoiceMemberRow({ member, menuOpen: menu, onMenu }: { member: VoiceMember; menuOpen: boolean; onMenu: (open: boolean) => void }) {
  const client = useClient();
  const user = useApp((s) => s.users[member.userId]);
  const me = useApp((s) => s.me);
  const speaking = useVoice((v) => v.speaking.includes(member.userId) && v.channelId !== null);
  const s = useSettings();
  const isMe = me.id === member.userId;
  const since = useApp((s) => s.onlineSince[member.userId]);
  const volume = s.userVolumes[String(member.userId)] ?? 1;

  return (
    <div className="voice-member-wrap">
      <div
        className="voice-member"
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(isMe ? false : !menu);
        }}
        title={`${since ? `Online ${formatDuration(Date.now() - since)}` : ''}${isMe ? '' : '\nDesni klik: jačina, poke'}`}
      >
        <Avatar user={user} size={22} baseUrl={client.api.baseUrl} speaking={speaking} />
        <span className="voice-member-name">{user?.displayName || '...'}</span>
        <span className="voice-flags">
          {member.streaming && <span className="live-tag">UŽIVO</span>}
          {member.muted && !member.deafened && <Icon name="micOff" size={14} />}
          {member.deafened && <Icon name="headphonesOff" size={14} />}
        </span>
      </div>
      {menu && (
        <div className="member-menu" onMouseLeave={() => onMenu(false)} onClick={(e) => e.stopPropagation()}>
          <label>
            Jačina: {Math.round(volume * 100)}%
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={volume}
              onChange={(e) => client.voice.setUserVolume(member.userId, Number(e.target.value))}
            />
          </label>
          <button className="small" onClick={() => { onMenu(false); client.openPoke(member.userId); }}>
            <Icon name="bell" size={14} /> Poke
          </button>
          {me.role === 'admin' && (
            <button className="danger small" onClick={() => client.api.voiceKick(member.userId).catch((err) => alert(err.message))}>
              Izbaci iz kanala
            </button>
          )}
          <button className="small" onClick={() => settings.set({ userVolumes: { ...s.userVolumes, [String(member.userId)]: 1 } })}>
            Vrati na 100%
          </button>
        </div>
      )}
    </div>
  );
}

function VoiceStatusPanel() {
  const client = useClient();
  const channelId = useVoice((v) => v.channelId);
  const status = useVoice((v) => v.status);
  const quality = useVoice((v) => v.quality);
  const streaming = useVoice((v) => v.streaming);
  const error = useVoice((v) => v.error);
  const channel = useApp((s) => s.channels.find((c) => c.id === channelId));

  if (error && channelId === null) {
    return (
      <div className="voice-status error-panel">
        <span>{error}</span>
        <button className="icon-btn small" onClick={() => client.voice.clearError()} title="Zatvori">
          <Icon name="x" size={16} />
        </button>
      </div>
    );
  }
  if (channelId === null) return null;

  const label =
    status === 'connecting' ? 'Spajam se...' : status === 'reconnecting' ? 'Ponovo se spajam...' : 'Glas spojen';
  return (
    <div className="voice-status">
      <div className="voice-status-info" onClick={() => client.showVoiceView()}>
        <span className={`voice-status-label q-${status === 'connected' ? quality : 'connecting'}`}>
          <Icon name="signal" size={16} /> {label}
        </span>
        <span className="muted small">{channel?.name}</span>
      </div>
      <div className="voice-status-actions">
        <button
          className={`icon-btn ${streaming ? 'on' : ''}`}
          title={streaming ? 'Zaustavi stream' : 'Streamaj ekran ili aplikaciju'}
          disabled={status !== 'connected'}
          onClick={() => (streaming ? client.voice.stopScreenShare() : client.voice.startScreenShare())}
        >
          <Icon name={streaming ? 'screenOff' : 'screen'} size={18} />
        </button>
        <button className="icon-btn danger" title="Izađi iz kanala" onClick={() => client.voice.leave()}>
          <Icon name="phoneOff" size={18} />
        </button>
      </div>
      {error && <div className="voice-error" onClick={() => client.voice.clearError()}>{error}</div>}
    </div>
  );
}

function UserPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const client = useClient();
  const me = useApp((s) => s.me);
  const muted = useVoice((v) => v.muted);
  const deafened = useVoice((v) => v.deafened);
  const transmitting = useVoice((v) => v.transmitting);
  const s = useSettings();

  return (
    <div className="user-panel">
      <Avatar user={me} size={32} baseUrl={client.api.baseUrl} speaking={transmitting} />
      <div className="user-panel-name">
        <span>{me.displayName}</span>
        <span className="muted small">{s.voiceMode === 'ptt' ? `PTT: ${s.hotkeys.ptt?.name || 'nije postavljeno'}` : '@' + me.username}</span>
      </div>
      <button className={`icon-btn ${muted ? 'off' : ''}`} title={muted ? 'Uključi mikrofon' : 'Isključi mikrofon'} onClick={() => client.voice.toggleMute()}>
        <Icon name={muted ? 'micOff' : 'mic'} size={18} />
      </button>
      <button className={`icon-btn ${deafened ? 'off' : ''}`} title={deafened ? 'Uključi zvuk' : 'Isključi zvuk (deafen)'} onClick={() => client.voice.toggleDeafen()}>
        <Icon name={deafened ? 'headphonesOff' : 'headphones'} size={18} />
      </button>
      <button className="icon-btn" title="Postavke" onClick={onOpenSettings}>
        <Icon name="settings" size={18} />
      </button>
    </div>
  );
}
