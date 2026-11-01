import http from 'node:http';
import net from 'node:net';

// Prosljeđuje LiveKit signalizaciju (/rtc...) kroz isti port kao backend,
// tako da kod privremenog hostinga treba otvoriti manje portova.

export function isRtcPath(url) {
  return /^\/rtc(\/|\?|$)/.test(url || '');
}

export function proxyHttp(req, res, internalUrl) {
  const target = new URL(internalUrl);
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: target.host },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, { ...up.headers, 'access-control-allow-origin': '*' });
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('LiveKit nije dostupan');
  });
  req.pipe(upstream);
}

export function proxyUpgrade(req, socket, head, internalUrl, clientIp) {
  const target = new URL(internalUrl);
  const upstream = net.connect(Number(target.port || 80), target.hostname);
  const fail = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.setNoDelay(true);
  socket.setNoDelay(true);
  upstream.on('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const lower = name.toLowerCase();
      if (lower === 'host' || lower === 'x-forwarded-for') continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push(`Host: ${target.host}`);
    lines.push(`X-Forwarded-For: ${clientIp}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', fail);
  socket.on('error', fail);
  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}
