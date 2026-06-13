'use strict';

const accounts = require('../auth/accounts');
const { c } = require('../util/ansi');

// `cloudferry accounts [remove <key>]`
async function accountsCommand(sub, key) {
  if (sub === 'remove' || sub === 'rm' || sub === 'disconnect') {
    if (!key) throw new Error('Usage: cloudferry accounts remove <key>');
    const ok = accounts.removeAccount(key);
    console.log(ok ? c.green(`Removed account "${key}".`) : c.yellow(`No account "${key}" found.`));
    return;
  }

  const list = accounts.listAccounts();
  if (list.length === 0) {
    console.log('No accounts connected yet.');
    console.log(`Connect one with:  ${c.cyan('cloudferry connect')}`);
    return;
  }
  console.log(c.bold('Connected accounts:'));
  for (const a of list) {
    console.log(`  ${c.green('●')} ${c.bold(a.label)}  ${c.dim('[' + a.provider + ']')}  ${c.dim('key=' + a.key)}`);
  }
  console.log(c.dim('\nRemove one with:  cloudferry accounts remove <key>'));
}

module.exports = { accountsCommand };
