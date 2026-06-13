'use strict';

const { setupGuide, listProviders } = require('../providers');
const { DEFAULT_PORT } = require('../auth/oauth');
const { c } = require('../util/ansi');

// `cloudferry guide [provider]` — print the API-key setup walkthrough without
// starting a connection.
function guideCommand(providerId, opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  if (!providerId) {
    console.log(c.bold('Setup guides are available for:'));
    for (const p of listProviders()) console.log(`  • ${p.name}  ${c.dim('cloudferry guide ' + p.id)}`);
    return;
  }
  const g = setupGuide(providerId, port);
  console.log('');
  console.log(c.bold(`Setting up a ${g.name} API app`));
  console.log(c.dim('─'.repeat(50)));
  g.steps.forEach((s, i) => console.log(`  ${c.cyan(String(i + 1).padStart(2))}. ${s}`));
  console.log('');
  console.log(`  Needs a client secret: ${g.needsSecret ? c.yellow('yes') : c.green('no (PKCE)')}`);
  console.log(`  When ready:  ${c.cyan('cloudferry connect ' + providerId)}`);
  console.log('');
}

module.exports = { guideCommand };
