'use strict';

const { DropboxProvider } = require('./dropbox');
const { GoogleDriveProvider } = require('./gdrive');
const { BoxProvider } = require('./box');
const { DEFAULT_PORT } = require('../auth/oauth');

const REGISTRY = {
  dropbox: DropboxProvider,
  gdrive: GoogleDriveProvider,
  box: BoxProvider,
};

function getProviderClass(id) {
  const cls = REGISTRY[id];
  if (!cls) throw new Error(`Unknown provider "${id}". Choose one of: ${Object.keys(REGISTRY).join(', ')}`);
  return cls;
}

function listProviders() {
  return Object.values(REGISTRY).map((c) => ({ id: c.id, name: c.displayName }));
}

// Step-by-step instructions for creating the OAuth app each provider needs.
// `port` is woven in so the redirect URI shown is always the one in use.
function setupGuide(id, port = DEFAULT_PORT) {
  const redirect = `http://localhost:${port}`;
  switch (id) {
    case 'dropbox':
      return {
        name: 'Dropbox',
        needsSecret: false,
        url: 'https://www.dropbox.com/developers/apps',
        steps: [
          'Open https://www.dropbox.com/developers/apps and click "Create app".',
          'Choose "Scoped access", then "Full Dropbox" access.',
          'Give it any name (e.g. "My CloudFerry Migration") and create it.',
          'On the app\'s "Permissions" tab, enable these scopes, then click Submit:',
          '    account_info.read, files.metadata.read, files.content.read, files.content.write',
          `On the "Settings" tab, under "OAuth 2 / Redirect URIs", add:  ${redirect}`,
          'Still on "Settings", copy the "App key" — that is your Client ID.',
          'Dropbox uses PKCE, so NO client secret is needed.',
        ],
      };
    case 'gdrive':
      return {
        name: 'Google Drive',
        needsSecret: true,
        url: 'https://console.cloud.google.com/',
        steps: [
          'Open https://console.cloud.google.com/ and create (or pick) a project.',
          'APIs & Services → Library → search "Google Drive API" → Enable.',
          'APIs & Services → OAuth consent screen → choose "External" → fill the basics.',
          '    Add your own Google account under "Test users" so you can authorize.',
          'APIs & Services → Credentials → Create credentials → "OAuth client ID".',
          '    Application type: "Desktop app".  Create it.',
          `    (Desktop apps allow the loopback redirect ${redirect} automatically.)`,
          'Copy the "Client ID" and "Client secret" from the dialog.',
        ],
      };
    case 'box':
      return {
        name: 'Box',
        needsSecret: true,
        url: 'https://app.box.com/developers/console',
        steps: [
          'Open https://app.box.com/developers/console and click "Create New App".',
          'Choose "Custom App", then authentication method "User Authentication (OAuth 2.0)".',
          'Give it a name and create it.',
          'On the "Configuration" tab, under "OAuth 2.0 Redirect URIs", add:',
          `    ${redirect}`,
          'Under "Application Scopes" enable "Read and write all files and folders".',
          'Copy the "Client ID" and "Client Secret" from the same tab.',
          'If your Box account is an enterprise one, an admin may need to authorize the app.',
        ],
      };
    default:
      throw new Error(`No setup guide for "${id}"`);
  }
}

module.exports = { REGISTRY, getProviderClass, listProviders, setupGuide };
