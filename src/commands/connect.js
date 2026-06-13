'use strict';

const accounts = require('../auth/accounts');
const prompts = require('../util/prompts');
const { listProviders } = require('../providers');
const { c } = require('../util/ansi');

// `cloudferry connect [provider]`
async function connectCommand(providerId, opts = {}) {
  if (!providerId) {
    providerId = await prompts.select('Which cloud provider do you want to connect?',
      listProviders().map((p) => ({ name: p.name, value: p.id })));
  }
  await accounts.connectInteractive(providerId, { port: opts.port });
  console.log(c.dim('\nConnect another with `cloudferry connect`, or start with `cloudferry migrate`.'));
}

module.exports = { connectCommand };
