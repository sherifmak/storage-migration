'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// Shared building blocks for the "installed app" OAuth flow used by all three
// providers: generate PKCE, pop the browser, and run a tiny localhost server to
// catch the redirect. The default redirect port is fixed (53682, the rclone
// convention) so users can register one exact redirect URI per provider.

const DEFAULT_PORT = 53682;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PKCE verifier/challenge pair (RFC 7636, S256).
function generatePkce() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

function randomState() {
  return base64url(crypto.randomBytes(24));
}

function redirectUri(port = DEFAULT_PORT) {
  return `http://localhost:${port}`;
}

// Open the system browser at `url`. Falls back to just printing the URL.
function openBrowser(url) {
  const platform = process.platform;
  let cmd, args;
  if (platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '""', url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* user will copy/paste the printed URL */
  }
}

/**
 * Run the redirect-capture server and return the authorization code.
 * Builds the final authorize URL via `buildAuthorizeUrl(redirectUri, state)`.
 *
 * @returns {Promise<{code: string, redirectUri: string}>}
 */
function authorizeViaLoopback({ buildAuthorizeUrl, port = DEFAULT_PORT, timeoutMs = 300000, onUrl }) {
  const state = randomState();
  const redirect = redirectUri(port);
  const authorizeUrl = buildAuthorizeUrl(redirect, state);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, redirect);
      if (url.pathname !== '/' && url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const params = url.searchParams;
      const respond = (title, msg, ok) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(resultPage(title, msg, ok));
      };

      if (params.get('error')) {
        respond('Authorization failed', params.get('error_description') || params.get('error'), false);
        cleanup();
        reject(new Error(`Authorization denied: ${params.get('error')}`));
        return;
      }
      if (params.get('state') !== state) {
        respond('Authorization failed', 'State mismatch — please retry.', false);
        cleanup();
        reject(new Error('OAuth state mismatch (possible CSRF); aborted.'));
        return;
      }
      const code = params.get('code');
      if (!code) {
        respond('Authorization failed', 'No authorization code was returned.', false);
        return;
      }
      respond('All set!', 'CloudFerry is connected. You can close this tab and return to the terminal.', true);
      cleanup();
      resolve({ code, redirectUri: redirect });
    });

    let timer = null;
    function cleanup() {
      if (timer) clearTimeout(timer);
      server.close();
    }

    server.on('error', (err) => {
      cleanup();
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Close whatever is using it, or pass --port <n> ` +
          `(and register http://localhost:<n> as the redirect URI in your app settings).`));
      } else {
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      if (onUrl) onUrl(authorizeUrl);
      openBrowser(authorizeUrl);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for browser authorization (5 min).'));
      }, timeoutMs);
      if (timer.unref) timer.unref();
    });
  });
}

function resultPage(title, msg, ok) {
  const color = ok ? '#2e7d32' : '#c62828';
  return `<!doctype html><html><head><meta charset="utf-8"><title>CloudFerry</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#e6edf3;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#161b22;border:1px solid #30363d;border-radius:14px;padding:40px 48px;text-align:center;max-width:460px}
h1{margin:0 0 8px;color:${color}}p{color:#8b949e;line-height:1.5}</style></head>
<body><div class="card"><h1>${title}</h1><p>${msg}</p></div></body></html>`;
}

module.exports = {
  DEFAULT_PORT,
  generatePkce,
  randomState,
  redirectUri,
  openBrowser,
  authorizeViaLoopback,
  base64url,
};
