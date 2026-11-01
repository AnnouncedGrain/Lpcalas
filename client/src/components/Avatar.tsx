import { colorFor, initials } from '../lib/format';
import type { User } from '../lib/types';

export function Avatar({
  user,
  size = 32,
  baseUrl,
  speaking = false,
  online,
}: {
  user: User | undefined;
  size?: number;
  baseUrl: string;
  speaking?: boolean;
  online?: boolean;
}) {
  const name = user?.displayName || '?';
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  return (
    <span className={`avatar ${speaking ? 'speaking' : ''}`} style={style}>
      {user?.avatarUrl ? (
        <img src={baseUrl + user.avatarUrl} alt="" draggable={false} />
      ) : (
        <span className="avatar-fallback" style={{ background: colorFor(user?.id ?? 0) }}>
          {initials(name)}
        </span>
      )}
      {online !== undefined && <span className={`presence ${online ? 'on' : 'off'}`} />}
    </span>
  );
}
