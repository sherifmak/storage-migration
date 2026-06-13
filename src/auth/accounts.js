'use strict';

const config = require('../config');
const { c } = require('../util/ansi');
const prompts = require('../util/prompts');
const oauth = require('./oauth');
const { getProviderClass, setupGuide } = require('../providers');

// Load the persisted config once and write through on every change so that
// rotated refresh tokens (Box especially) are never lost mid-migration.
function load() {
  const cfg = config.loadConfig();
  cfg.apps = cfg.apps || {};
  cfg.accounts = cfg.accounts || {};
  return cfg;
}

function listAccounts(cfg = load()) {
  return Object.entries(cfg.accounts).map(([key, a]) => ({ key, ...a }));
}

// Resolve an account by its key, account id, label, or (when unambiguous) by
// provider id alone.
function findAccount(cfg, ref) {
  if (!ref) return null;
  if (cfg.accounts[ref]) return { key: ref, ...cfg.accounts[ref] };
  const all = listAccounts(cfg);
  const byId = all.filter((a) => a.accountId === ref || a.label === ref);
  if (byId.length === 1) return byId[0];
  const byProvider = all.filter((a) => a.provider === ref);
  if (byProvider.length === 1) return byProvider[0];
  if (byProvider.length > 1) {
    throw new Error(`Multiple ${ref} accounts connected; specify one of: ${byProvider.map((a) => a.key).join(', ')}`);
  }
  return null;
}

// Build a live provider instance bound to a saved account. Token refreshes are
// written straight back to disk.
function buildProvider(account, { logger } = {}) {
  const Cls = getProviderClass(account.provider);
  const provider = new Cls(account, {
    logger,
    saveTokens: (tokens) => {
      const cfg = load();
      if (cfg.accounts[account.key]) {
        cfg.accounts[account.key].tokens = tokens;
        config.saveConfig(cfg);
      }
    },
  });
  return provider;
}

// Full interactive "connect an account" experience: print the API-key guide,
// collect credentials, run the browser OAuth flow, verify, and persist.
async function connectInteractive(providerId, { port = oauth.DEFAULT_PORT, logger } = {}) {
  const Cls = getProviderClass(providerId);
  const guide = setupGuide(providerId, port);
  const cfg = load();

  console.log('');
  console.log(c.bold(`Connect a ${guide.name} account`));
  console.log(c.dim('─'.repeat(50)));

  // Offer to reuse previously entered app credentials.
  let app = cfg.apps[providerId];
  if (app && app.clientId) {
    const reuse = await prompts.confirm(`Reuse the saved ${guide.name} API app (Client ID ${mask(app.clientId)})?`, true);
    if (!reuse) app = null;
  }

  if (!app || !app.clientId) {
    console.log('');
    console.log(c.bold(`You'll need a ${guide.name} API app. Here's how to create one:`));
    guide.steps.forEach((s, i) => console.log(`  ${c.cyan(String(i + 1).padStart(2))}. ${s}`));
    console.log('');
    const clientId = await prompts.ask(`Paste your ${guide.name} Client ID / App key:`);
    if (!clientId) throw new Error('A Client ID is required.');
    const app2 = { clientId };
    if (guide.needsSecret) {
      const clientSecret = await prompts.askSecret(`Paste your ${guide.name} Client Secret:`);
      if (!clientSecret) throw new Error('A Client Secret is required for this provider.');
      app2.clientSecret = clientSecret;
    }
    app = app2;
    cfg.apps[providerId] = app;
    config.saveConfig(cfg);
  }

  // Browser OAuth.
  const authBuilder = Cls.buildAuthorize(app.clientId);
  console.log('');
  console.log(`Opening your browser to authorize ${guide.name}…`);
  const { code, redirectUri } = await oauth.authorizeViaLoopback({
    port,
    buildAuthorizeUrl: authBuilder.build,
    onUrl: (url) => {
      console.log(c.dim('If the browser did not open, paste this URL into it:'));
      console.log('  ' + c.underline(url));
    },
  });

  const tokens = await Cls.exchangeCode({
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    code,
    codeVerifier: authBuilder.pkce && authBuilder.pkce.verifier,
    redirectUri,
  });

  // Verify and label the account.
  const account = { provider: providerId, label: guide.name, app, tokens, accountId: tokens.accountId || null };
  const provider = new Cls(account, { logger });
  let info;
  try {
    info = await provider.getAccountInfo();
  } catch (err) {
    throw new Error(`Connected, but verifying the account failed: ${err.message}`);
  }
  account.accountId = info.accountId || account.accountId;
  account.label = info.label || account.label;
  account.tokens = provider.tokens; // capture any refresh that happened

  const key = makeKey(cfg, providerId, account.accountId);
  cfg.accounts[key] = account;
  config.saveConfig(cfg);

  console.log('');
  console.log(c.green(`✓ Connected ${guide.name}: ${c.bold(account.label)}  (saved as "${key}")`));
  return { key, ...account };
}

function makeKey(cfg, providerId, accountId) {
  const base = accountId ? `${providerId}:${accountId}` : providerId;
  if (!cfg.accounts[base]) return base;
  let i = 2;
  while (cfg.accounts[`${base}#${i}`]) i++;
  return `${base}#${i}`;
}

function removeAccount(key) {
  const cfg = load();
  if (!cfg.accounts[key]) return false;
  delete cfg.accounts[key];
  config.saveConfig(cfg);
  return true;
}

function mask(s) {
  if (!s) return '';
  return s.length <= 6 ? '••••' : `${s.slice(0, 3)}…${s.slice(-3)}`;
}

module.exports = { load, listAccounts, findAccount, buildProvider, connectInteractive, removeAccount };
