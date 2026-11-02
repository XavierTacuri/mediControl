'use strict';

const http = require('node:http');

// supertest no sirve para probar un stream SSE que nunca termina por sí
// solo: hace falta un socket http real (servidor en un puerto efímero) que
// la prueba cierre explícitamente. Este helper encapsula esa mecánica.

function parseSseChunk(buffer) {
  const events = [];
  const parts = buffer.split('\n\n');
  const leftover = parts.pop();

  for (const part of parts) {
    if (!part.trim()) continue;
    const lines = part.split('\n');
    let type = 'message';
    const dataLines = [];
    let isCommentOnly = true;

    for (const line of lines) {
      if (line.startsWith('event:')) {
        type = line.slice('event:'.length).trim();
        isCommentOnly = false;
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
        isCommentOnly = false;
      }
      // Las líneas que empiezan con ':' son comentarios SSE (el mensaje de
      // conexión inicial y los heartbeats) y se ignoran como datos.
    }

    if (!isCommentOnly && dataLines.length > 0) {
      let data;
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        data = dataLines.join('\n');
      }
      events.push({ type, data });
    }
  }

  return { events, leftover };
}

// Convierte las cabeceras Set-Cookie de una respuesta de supertest en un
// valor de cabecera Cookie apto para una petición http nativa.
function cookieHeaderFrom(setCookieArray) {
  return (setCookieArray || []).map((cookie) => cookie.split(';')[0]).join('; ');
}

function connectSse({ server, path, cookie, extraHeaders = {} }) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const headers = { ...extraHeaders };
    if (cookie) headers.Cookie = cookie;

    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let buffer = '';
      let rawBody = '';
      const events = [];

      res.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        rawBody += text;
        buffer += text;
        const { events: parsed, leftover } = parseSseChunk(buffer);
        events.push(...parsed);
        buffer = leftover;
      });

      const connection = {
        statusCode: res.statusCode,
        headers: res.headers,
        events,
        get rawBody() {
          return rawBody;
        },
        close: () => req.destroy(),
        waitFor(predicate, timeoutMs = 2000) {
          return new Promise((resolveWait, rejectWait) => {
            const start = Date.now();
            const check = () => {
              const found = events.find(predicate);
              if (found) return resolveWait(found);
              if (Date.now() - start > timeoutMs) {
                return rejectWait(new Error(`Timed out waiting for SSE event. Seen so far: ${JSON.stringify(events)}`));
              }
              setTimeout(check, 10);
            };
            check();
          });
        },
        waitForClose(timeoutMs = 2000) {
          return new Promise((resolveWait, rejectWait) => {
            if (res.complete || res.destroyed) return resolveWait();
            const timer = setTimeout(() => rejectWait(new Error('Timed out waiting for the SSE connection to close')), timeoutMs);
            res.on('end', () => {
              clearTimeout(timer);
              resolveWait();
            });
            res.on('close', () => {
              clearTimeout(timer);
              resolveWait();
            });
          });
        },
      };

      resolve(connection);
    });

    req.on('error', reject);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { connectSse, cookieHeaderFrom, wait };
