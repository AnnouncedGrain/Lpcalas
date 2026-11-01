// Kad server radi u Dockeru na kućnom računaru, LiveKit klijentima šalje samo javnu IP adresu
// za glas/video. Računar na kojem je server (i drugi u istoj mreži) do te adrese često ne mogu
// doći (ruter ne podržava "hairpin" NAT, ili portovi još nisu otvoreni) pa se glas prekine.
//
// Rješenje: glas/video ide na ISTU adresu koju je korisnik upisao za server (localhost,
// 192.168.x.x ili javna IP). Prepisujemo IP u kandidatima koje šalje server.
// Za domenu (pravi server) ništa se ne mijenja.

let overrideIp: string | null = null;
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

export function rewriteSdp(sdp: string, ip: string): string {
  return sdp
    .split(/\r\n|\n/)
    .map((l) => (l.startsWith('a=candidate:') ? rewriteCandidate(l, ip) : l))
    .join('\r\n');
}

export function setIceOverride(ip: string | null) {
  overrideIp = ip;
  if (ip && !installed) install();
}

function install() {
  if (typeof RTCPeerConnection === 'undefined') return;
  installed = true;
  const proto = RTCPeerConnection.prototype;

  const origAdd = proto.addIceCandidate;
  proto.addIceCandidate = function (this: RTCPeerConnection, candidate?: RTCIceCandidateInit | RTCIceCandidate | null, ...rest: any[]) {
    if (overrideIp && candidate && candidate.candidate) {
      candidate = {
        candidate: rewriteCandidate(candidate.candidate, overrideIp),
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment ?? undefined,
      };
    }
    return (origAdd as any).call(this, candidate, ...rest);
  } as typeof proto.addIceCandidate;

  const origSet = proto.setRemoteDescription;
  proto.setRemoteDescription = function (this: RTCPeerConnection, desc?: RTCSessionDescriptionInit, ...rest: any[]) {
    if (overrideIp && desc?.sdp) desc = { type: desc.type, sdp: rewriteSdp(desc.sdp, overrideIp) };
    return (origSet as any).call(this, desc, ...rest);
  } as typeof proto.setRemoteDescription;
}
