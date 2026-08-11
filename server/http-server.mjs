import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serialize(value) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

function allowedOrigin(requestOrigin, configured) {
  if (configured === '*') return '*';
  const origins = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return requestOrigin && origins.includes(requestOrigin) ? requestOrigin : null;
}

function applyCors(req, res, corsOrigin) {
  const origin = allowedOrigin(req.headers.origin, corsOrigin);
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
}

function json(res, status, body) {
  const payload = serialize(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function existingFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? path : null;
  } catch {
    return null;
  }
}

async function serveStatic(req, res, staticDir, pathname) {
  let requested;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    json(res, 400, { error: 'Invalid URL' });
    return;
  }

  const root = resolve(staticDir);
  const relative = requested === '/' ? 'index.html' : `.${requested}`;
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    json(res, 403, { error: 'Forbidden' });
    return;
  }

  const file = (await existingFile(candidate)) || (await existingFile(join(root, 'index.html')));
  if (!file) {
    json(res, 404, { error: 'Website build not found' });
    return;
  }

  const info = await stat(file);
  const headers = {
    'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': file.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=3600',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}

export function createArchiveHttpServer({
  store,
  events,
  packageId,
  eventType,
  staticDir,
  corsOrigin = '*',
  maxSseClients = 250,
  health = () => ({}),
}) {
  let activeStreams = 0;

  return createServer(async (req, res) => {
    applyCors(req, res, corsOrigin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/api/') && req.method !== 'GET') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (url.pathname === '/api/archives') {
      json(res, 200, {
        archives: store.listArchives(),
        generatedAt: store.getMeta('generatedAt'),
        packageId,
        eventType,
      });
      return;
    }

    if (url.pathname === '/api/health') {
      const archiveCount = store.countArchives();
      const generatedAt = store.getMeta('generatedAt');
      const details = health();
      const cacheReady = Boolean(generatedAt) || archiveCount > 0;
      const listenerConnected = Boolean(details.listener?.connected);
      const operational = cacheReady || listenerConnected;
      json(res, operational ? 200 : 503, {
        status: cacheReady && listenerConnected ? 'ok' : operational ? 'degraded' : 'starting',
        archiveCount,
        generatedAt,
        activeStreams,
        ...details,
      });
      return;
    }

    if (url.pathname === '/api/archives/stream') {
      if (activeStreams >= maxSseClients) {
        res.setHeader('Retry-After', '30');
        json(res, 503, { error: 'Archive stream is at capacity' });
        return;
      }
      activeStreams += 1;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let closed = false;
      let unsubscribe = () => {};
      let heartbeat;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        activeStreams -= 1;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
      };
      const write = (payload) => {
        if (closed) return;
        try {
          if (!res.write(payload)) {
            cleanup();
            res.end();
          }
        } catch {
          cleanup();
        }
      };
      write(`event: ready\ndata: ${serialize({ generatedAt: store.getMeta('generatedAt') })}\n\n`);
      unsubscribe = events.subscribe((archive) => {
        write(`event: archive\ndata: ${serialize(archive)}\n\n`);
      });
      if (closed) {
        unsubscribe();
        return;
      }
      heartbeat = setInterval(() => write(': keep-alive\n\n'), 20_000);
      heartbeat.unref();
      req.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      json(res, 404, { error: 'Not found' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }
    await serveStatic(req, res, staticDir, url.pathname);
  });
}
