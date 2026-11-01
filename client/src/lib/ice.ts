// Kad server radi u Dockeru na kućnom računaru, LiveKit klijentima šalje samo javnu IP adresu
// za glas/video. Računar na kojem je server (i drugi u istoj mreži) do te adrese često ne mogu
// doći (ruter ne podržava "hairpin" NAT, ili portovi još nisu otvoreni) pa se glas prekine.
//
// Rješenje: glas/video ide na ISTU adresu koju je korisnik upisao za server (192.168.x.x ili
// javna IP). Prepisujemo IP u kandidatima koje šalje server. Za domenu ništa se ne mijenja.
//
// Za "localhost": Windows (strong host model) ne pušta paket s mrežne kartice na 127.0.0.1,
// pa šaljemo na vlastite mrežne adrese računara (Docker sluša na svim) i, kao rezervu, 127.0.0.1.

let overrideIps: string[] | null = null;
let installed = false;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function iceOverrideFor(serverUrl: string): string | null {
  try {
    const host = new URL(serverUrl).hostname;
    if (host === 'localhost') return '127.0.0.1';
    if (IPV4.test(host)) return host;
  } catch {
    /* neispravan URL */
  }
  return null;
}

// "candidate:<foundation> <component> <udp|tcp> <priority> <ip> <port> typ ..."
const CANDIDATE = /^((?:a=)?candidate:\S+ \d+ (?:udp|tcp) \d+ )(\S+)( \d+ typ .*)$/i;

export function rewriteCandidate(line: string, ip: string): string {
  const m = CANDIDATE.exec(line);
  if (!m) return line;
  // Samo IPv4 (IPv6 i mDNS ostavljamo kakvi jesu).
  if (!IPV4.test(m[2])) return line;
  return m[1] + ip + m[3];
}

export function rewriteSdp(sdp: string, ips: string[]): string {
  return sdp
    .split(/\r\n|\n/)
    .flatMap((l) => (l.startsWith('a=candidate:') ? [...new Set(ips.map((ip) => rewriteCandidate(l, ip)))] : [l]))
    .join('\r\n');
}

export function setIceOverride(ips: string[] | null) {
  overrideIps = ips && ips.length ? [...new Set(ips)] : null;
  if (overrideIps && !installed) install();
}

// Vlastite IPv4 adrese ovog računara (iz WebRTC "host" kandidata).
export async function discoverLocalIps(timeoutMs = 1500): Promise<string[]> {
  if (typeof RTCPeerConnection === 'undefined') return [];
  const ips = new Set<string>();
  const pc = new RTCPeerConnection();
  try {
    pc.createDataChannel('probe');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const m = /^candidate:\S+ \d+ udp \d+ (\S+) \d+ typ host/i.exec(e.candidate.candidate);
        if (m && IPV4.test(m[1]) && !m[1].startsWith('127.')) ips.add(m[1]);
      };
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => resolve());
    });
  } finally {
    pc.close();
  }
  // Kućna mreža prva (192.168.x / 10.x), virtuelni adapteri (172.x) poslije.
  return [...ips].sort((a, b) => rank(a) - rank(b));
}

function rank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  return 2;
}

export async function iceTargetsFor(serverUrl: string): Promise<string[] | null> {
  const ip = iceOverrideFor(serverUrl);
  if (ip !== '127.0.0.1') return ip ? [ip] : null;
  return [...(await discoverLocalIps()), '127.0.0.1'];
}

function install() {
  if (typeof RTCPeerConnection === 'undefined') return;
  installed = true;
  const proto = RTCPeerConnection.prototype;

  const origAdd = proto.addIceCandidate;
  proto.addIceCandidate = function (this: RTCPeerConnection, candidate?: RTCIceCandidateInit | RTCIceCandidate | null, ...rest: any[]) {
    const ips = overrideIps;
    if (!ips || !candidate || !candidate.candidate || !CANDIDATE.test(candidate.candidate)) {
      return (origAdd as any).call(this, candidate, ...rest);
    }
    const c = candidate;
    const variants = [...new Set(ips.map((ip) => rewriteCandidate(c.candidate!, ip)))];
    return Promise.all(
      variants.map((line) =>
        (origAdd as any)
          .call(this, { candidate: line, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment ?? undefined })
          .catch(() => {}),
      ),
    ).then(() => undefined);
  } as typeof proto.addIceCandidate;

  const origSet = proto.setRemoteDescription;
  proto.setRemoteDescription = function (this: RTCPeerConnection, desc?: RTCSessionDescriptionInit, ...rest: any[]) {
    if (overrideIps && desc?.sdp) desc = { type: desc.type, sdp: rewriteSdp(desc.sdp, overrideIps) };
    return (origSet as any).call(this, desc, ...rest);
  } as typeof proto.setRemoteDescription;
}
