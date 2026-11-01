#!/usr/bin/env node
/**
 * One-time setup for saving orders in Google Drive.
 *
 * Signs in with your Google account (OAuth "Desktop app" client, scope drive.file), creates the
 * orders folder, and prints GOOGLE_REFRESH_TOKEN + ORDERS_FOLDER_ID for the Vercel settings.
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-refresh-token.mjs
 * Options:
 *   --no-folder   only get a new refresh token (keep the existing orders folder)
 */
import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';

const PORT = 53682;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'הזמנות';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const createFolder = !process.argv.includes('--no-folder');
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see the setup instructions).');
  process.exit(1);
}

const redirectUri = `http://127.0.0.1:${PORT}/callback`;
const state = crypto.randomBytes(16).toString('hex');
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
}).toString();

let done = false;

async function finish(callbackUrl) {
  if (done) return;
  const url = new URL(callbackUrl, redirectUri);
  if (url.searchParams.get('error')) throw new Error('Google returned: ' + url.searchParams.get('error'));
  if (url.searchParams.get('state') !== state) throw new Error('State mismatch — start again.');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('No code in the URL.');
  done = true;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) throw new Error('Token exchange failed: ' + JSON.stringify(tokens));
  if (!tokens.refresh_token) throw new Error('No refresh token returned. Remove the app access at https://myaccount.google.com/permissions and run again.');

  let folderId = '';
  if (createFolder) {
    const folderRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tokens.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    const folder = await folderRes.json();
    if (!folderRes.ok) throw new Error('Creating the orders folder failed: ' + JSON.stringify(folder));
    folderId = folder.id;
  }

  console.log('\nDone. Add these to Vercel → Settings → Environment Variables:\n');
  console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
  if (folderId) console.log('ORDERS_FOLDER_ID=' + folderId);
  console.log('\nKeep the refresh token secret.');
  if (folderId) console.log(`The folder "${FOLDER_NAME}" was created in My Drive. You may move or rename it, but do not delete it.`);
}

function fail(err) {
  console.error('\n' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (!req.url?.startsWith('/callback')) {
    res.writeHead(404).end();
    return;
  }
  finish(req.url)
    .then(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Done — you can close this tab and return to the terminal.');
      process.exit(0);
    })
    .catch((err) => {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(err.message ?? err));
      fail(err);
    });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('1. Open this URL in a browser and allow access:\n\n' + authUrl + '\n');
  console.log('2. If the browser then shows "This site can\'t be reached", copy the full address from the');
  console.log('   address bar (it starts with ' + redirectUri + ') and paste it here:\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    finish(text)
      .then(() => process.exit(0))
      .catch(fail);
  });
});
