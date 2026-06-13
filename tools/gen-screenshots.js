'use strict';

// Generates "screenshots" of the CloudFerry terminal experience as standalone
// SVG files styled like a dark terminal window. SVG (not PNG) because this
// environment has no rasteriser; SVGs render crisply as images anywhere and
// keep perfect monospace alignment via per-run textLength.

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

// GitHub-dark-ish palette, matching the app's ANSI colours.
const PAL = {
  fg: '#e6edf3',
  dim: '#8b949e',
  cyan: '#56d4dd',
  green: '#3fb950',
  red: '#f85149',
  yellow: '#d29922',
  magenta: '#bc8cff',
  blue: '#58a6ff',
};

// Run builders: each returns a styled segment {t, c, b}.
const t = (s) => ({ t: s, c: 'fg' });
const dim = (s) => ({ t: s, c: 'dim' });
const cyan = (s) => ({ t: s, c: 'cyan' });
const green = (s) => ({ t: s, c: 'green' });
const red = (s) => ({ t: s, c: 'red' });
const yellow = (s) => ({ t: s, c: 'yellow' });
const mag = (s) => ({ t: s, c: 'magenta' });
const blue = (s) => ({ t: s, c: 'blue' });
const b = (run) => ({ ...run, b: true });
const L = (...runs) => runs;            // a line = list of runs
const BLANK = [];

// Layout metrics.
const FS = 15, CELL = 9, LH = 21, PADX = 16, PADTOP = 46, PADBOT = 18;
const FONT = "'DejaVu Sans Mono','SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";

function cps(s) { return [...s].length; } // code-point length (emoji-safe)

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(title, lines) {
  const cols = Math.max(40, ...lines.map((ln) => ln.reduce((n, r) => n + cps(r.t), 0)), cps(title) + 8);
  const W = cols * CELL + PADX * 2;
  const H = lines.length * LH + PADTOP + PADBOT;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
  // Window + title bar.
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="10" fill="#0d1117"/>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="34" rx="10" fill="#161b22"/>`);
  parts.push(`<rect x="0" y="22" width="${W}" height="12" fill="#161b22"/>`);
  parts.push(`<line x1="0" y1="34" x2="${W}" y2="34" stroke="#30363d" stroke-width="1"/>`);
  parts.push(`<circle cx="18" cy="17" r="6" fill="#f85149"/><circle cx="38" cy="17" r="6" fill="#d29922"/><circle cx="58" cy="17" r="6" fill="#3fb950"/>`);
  parts.push(`<text x="${W / 2}" y="22" fill="#8b949e" font-size="13" text-anchor="middle">${esc(title)}</text>`);
  parts.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="none" stroke="#30363d" stroke-width="1"/>`);

  // Body text, one <text> per styled run, absolutely positioned by column.
  lines.forEach((ln, row) => {
    let col = 0;
    const y = PADTOP + row * LH;
    for (const run of ln) {
      const len = cps(run.t);
      if (run.t.trim() !== '' || run.c !== 'fg') {
        const x = PADX + col * CELL;
        const fill = PAL[run.c] || PAL.fg;
        const weight = run.b ? ' font-weight="bold"' : '';
        parts.push(`<text x="${x}" y="${y}" fill="${fill}" font-size="${FS}"${weight} textLength="${len * CELL}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(run.t)}</text>`);
      }
      col += len;
    }
  });
  parts.push('</svg>');
  return parts.join('\n');
}

function write(name, title, lines) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, render(title, lines));
  console.log('wrote', path.relative(process.cwd(), file));
}

// ── helpers for the dashboard box ──────────────────────────────────────────
function barRuns(frac, width) {
  const filled = Math.round(frac * width);
  return [green('█'.repeat(filled)), dim('░'.repeat(width - filled))];
}
function row(inner, runs) {
  const used = runs.reduce((n, r) => n + cps(r.t), 0);
  const pad = Math.max(0, inner - used);
  return [dim('║ '), ...runs, t(' '.repeat(pad)), dim(' ║')];
}
function topBorder(inner) { return [dim('╔' + '═'.repeat(inner + 2) + '╗')]; }
function botBorder(inner) { return [dim('╚' + '═'.repeat(inner + 2) + '╝')]; }
function sep(label, inner) {
  const txt = label ? `─ ${label} ` : '';
  return [dim('╟' + txt + '─'.repeat(inner + 2 - cps(txt)) + '╢')];
}

// ════════════════════════════════════════════════════════════════════════════
// 01 — connect: provider selection
// ════════════════════════════════════════════════════════════════════════════
write('01-connect-select.svg', 'cloudferry connect', [
  L(green('$'), t(' '), b(t('cloudferry connect'))),
  BLANK,
  L(cyan('?'), t(' Which cloud provider do you want to connect?')),
  L(t('  '), b(t('1')), t(') Dropbox')),
  L(t('  '), b(t('2')), t(') Google Drive')),
  L(t('  '), b(t('3')), t(') Box')),
  L(cyan('?'), t(' Enter a number '), t('1')),
]);

// ════════════════════════════════════════════════════════════════════════════
// 02 — guided API-key setup (Dropbox)
// ════════════════════════════════════════════════════════════════════════════
write('02-guide-dropbox.svg', 'cloudferry connect dropbox', [
  L(green('$'), t(' '), b(t('cloudferry connect dropbox'))),
  BLANK,
  L(b(t('Connect a Dropbox account'))),
  L(dim('──────────────────────────────────────────────────')),
  BLANK,
  L(b(t("You'll need a Dropbox API app. Here's how to create one:"))),
  L(cyan('   1'), t('. Open https://www.dropbox.com/developers/apps and click "Create app".')),
  L(cyan('   2'), t('. Choose "Scoped access", then "Full Dropbox" access.')),
  L(cyan('   3'), t('. Give it any name and create it.')),
  L(cyan('   4'), t('. On the "Permissions" tab, enable these scopes, then Submit:')),
  L(t('         account_info.read, files.metadata.read,')),
  L(t('         files.content.read, files.content.write')),
  L(cyan('   5'), t('. On "Settings" → "OAuth 2 / Redirect URIs", add:')),
  L(t('         '), cyan('http://localhost:53682')),
  L(cyan('   6'), t('. Copy the "App key" — that is your Client ID.')),
  L(cyan('   7'), t('. Dropbox uses PKCE, so '), b(t('NO client secret')), t(' is needed.')),
  BLANK,
  L(cyan('?'), t(' Paste your Dropbox Client ID / App key: '), t('a1b2c3d4e5f6g7h')),
]);

// ════════════════════════════════════════════════════════════════════════════
// 03 — OAuth browser handoff + success
// ════════════════════════════════════════════════════════════════════════════
write('03-connect-oauth.svg', 'cloudferry connect dropbox', [
  L(t('Opening your browser to authorize Dropbox…')),
  L(dim('If the browser did not open, paste this URL into it:')),
  L(t('  '), blue('https://www.dropbox.com/oauth2/authorize?client_id=a1b2c3…')),
  BLANK,
  L(dim('Waiting for authorization on http://localhost:53682 …')),
  BLANK,
  L(green('✓'), t(' Connected Dropbox: '), b(t('jane@example.com')), t('  '), dim('(saved as "dropbox:dbid:AAH…")')),
  BLANK,
  L(dim('Connect another with `cloudferry connect`, or start with `cloudferry migrate`.')),
]);

// ════════════════════════════════════════════════════════════════════════════
// 04 — accounts list
// ════════════════════════════════════════════════════════════════════════════
write('04-accounts.svg', 'cloudferry accounts', [
  L(green('$'), t(' '), b(t('cloudferry accounts'))),
  BLANK,
  L(b(t('Connected accounts:'))),
  L(t('  '), green('●'), t(' '), b(t('jane@example.com')), t('  '), dim('[dropbox]'), t('  '), dim('key=dropbox:dbid:AAH…')),
  L(t('  '), green('●'), t(' '), b(t('jane@gmail.com')), t('   '), dim('[gdrive]'), t('   '), dim('key=gdrive:jane@gmail.com')),
  L(t('  '), green('●'), t(' '), b(t('jane (Box)')), t('       '), dim('[box]'), t('      '), dim('key=box:1098…')),
  BLANK,
  L(dim('Remove one with:  cloudferry accounts remove <key>')),
]);

// ════════════════════════════════════════════════════════════════════════════
// 05 — migrate wizard
// ════════════════════════════════════════════════════════════════════════════
write('05-migrate-wizard.svg', 'cloudferry migrate', [
  L(green('$'), t(' '), b(t('cloudferry migrate'))),
  BLANK,
  L(cyan('?'), t(' Migrate FROM which account?')),
  L(t('  '), b(t('1')), t(') jane@example.com '), dim('(dropbox:dbid:AAH…)'), t('  '), dim('— dropbox')),
  L(t('  '), b(t('2')), t(') jane@gmail.com '), dim('(gdrive:jane@gmail.com)'), t('  '), dim('— gdrive')),
  L(cyan('?'), t(' Enter a number '), t('1')),
  BLANK,
  L(cyan('?'), t(' Migrate TO which account?')),
  L(t('  '), b(t('1')), t(') jane@gmail.com '), dim('(gdrive:jane@gmail.com)'), t('  '), dim('— gdrive')),
  L(cyan('?'), t(' Enter a number '), t('1')),
  BLANK,
  L(cyan('?'), t(' Source folder on jane@example.com '), dim('(path like /Photos, blank = whole Dropbox)'), t(': '), t('/Photos')),
  L(cyan('?'), t(' Destination folder on jane@gmail.com '), dim('(folder ID, blank = My Drive root)'), t(': '), dim('root')),
  L(cyan('?'), t(' Parallel transfers '), dim('[4]'), t(' '), t('6')),
  BLANK,
  L(b(t('About to migrate:'))),
  L(t('  From  '), cyan('jane@example.com'), t('  '), dim('(/Photos)')),
  L(t('  To    '), cyan('jane@gmail.com'), t('  '), dim('(account root)')),
  L(t('  Parallel transfers: 6')),
  L(cyan('?'), t(' Start the migration? '), dim('(Y/n)'), t(' '), t('y')),
]);

// ════════════════════════════════════════════════════════════════════════════
// 06 — discovery (scanning)
// ════════════════════════════════════════════════════════════════════════════
(() => {
  const inner = 64;
  write('06-discovery.svg', 'cloudferry migrate — scanning', [
    topBorder(inner),
    row(inner, [b(cyan('CloudFerry')), dim('  ·  '), b(t('Dropbox')), cyan(' → '), b(t('Google Drive'))]),
    sep(null, inner),
    row(inner, [cyan('⠹'), t(' Scanning source… '), b(t('18,204')), t(' items found')]),
    row(inner, [dim('Building the migration manifest before transferring.')]),
    sep('Workers', inner),
    row(inner, [dim('1  idle')]),
    row(inner, [dim('2  idle')]),
    botBorder(inner),
    L(dim('  Press Ctrl-C to pause safely — progress is saved, resume anytime.')),
  ]);
})();

// ════════════════════════════════════════════════════════════════════════════
// 07 — main dashboard (the hero shot)
// ════════════════════════════════════════════════════════════════════════════
(() => {
  const inner = 64;
  const w1 = barRuns(0.81, 10), w2 = barRuns(0.31, 10), w4 = barRuns(0.99, 10), w5 = barRuns(0.12, 10);
  const overall = barRuns(0.52, 40);
  write('07-dashboard.svg', 'cloudferry migrate — transferring', [
    topBorder(inner),
    row(inner, [b(cyan('CloudFerry')), dim('  ·  '), b(t('Dropbox')), cyan(' → '), b(t('Google Drive'))]),
    sep(null, inner),
    row(inner, [b(t('Overall')), t('  '), ...overall, t('  '), t(' 52%')]),
    row(inner, [dim('Files '), t('12,403'), dim('/'), t('23,910'), t('      '), dim('Data '), t('142.3 GB'), dim('/'), t('271.0 GB')]),
    row(inner, [dim('Speed '), green('48.2 MB/s'), dim('   ·   '), dim('ETA '), t('00:41:12'), dim('   ·   '), dim('Elapsed '), t('02:13:55')]),
    row(inner, [dim('Active '), t('4'), dim('   Failed '), t('0'), dim('   Skipped '), t('0'), dim('   Pending '), t('11,503')]),
    sep('Workers', inner),
    row(inner, [t('1 '), green('⬆'), t(' photos/2021/IMG_3920.mov     '), ...w1, t('  81%')]),
    row(inner, [t('2 '), cyan('⬇'), t(' docs/Q3 Report.pdf           '), ...w2, t('  31%')]),
    row(inner, [t('3 '), cyan('⬇'), t(' music/live/encore.flac       '), ...w5, t('  12%')]),
    row(inner, [t('4 '), green('⬆'), t(' archive/2019-backup.zip      '), ...w4, t('  99%')]),
    sep('Recent', inner),
    row(inner, [green('✓'), t(' music/track01.flac')]),
    row(inner, [green('✓'), t(' docs/notes/meeting.txt')]),
    botBorder(inner),
    L(dim('  Press Ctrl-C to pause safely — progress is saved, resume anytime.')),
  ]);
})();

// ════════════════════════════════════════════════════════════════════════════
// 08 — safe pause on Ctrl-C
// ════════════════════════════════════════════════════════════════════════════
write('08-pause.svg', 'cloudferry migrate — paused', [
  L(t('^C')),
  L(yellow('Pausing — finishing in-flight chunks and saving progress…')),
  BLANK,
  L(b(yellow('⏸  Migration paused.'))),
  L(dim('──────────────────────────────────────────────────')),
  L(t('  Job        dropbox-to-gdrive-20260613-162600')),
  L(t('  Transferred '), green('12,540'), t(' files  (143.9 GB)')),
  L(t('  Remaining  11,370 files')),
  L(dim('  Log: ~/.cloudferry/jobs/dropbox-to-gdrive-20260613-162600/migration.log')),
  BLANK,
  L(t('  Resume any time with:  '), cyan('cloudferry resume dropbox-to-gdrive-20260613-162600')),
]);

// ════════════════════════════════════════════════════════════════════════════
// 09 — completion summary
// ════════════════════════════════════════════════════════════════════════════
write('09-complete.svg', 'cloudferry resume — complete', [
  L(green('$'), t(' '), b(t('cloudferry resume'))),
  L(dim('Resuming most recent job: dropbox-to-gdrive-20260613-162600')),
  L(dim('  … dashboard runs to completion …')),
  BLANK,
  L(b(green('✓  Migration complete!'))),
  L(dim('──────────────────────────────────────────────────')),
  L(t('  Job        dropbox-to-gdrive-20260613-162600')),
  L(t('  Transferred '), green('23,910'), t(' files  (271.0 GB)')),
  L(t('  Remaining  0 files')),
  L(dim('  Log: ~/.cloudferry/jobs/dropbox-to-gdrive-20260613-162600/migration.log')),
]);

// ════════════════════════════════════════════════════════════════════════════
// 10 — status command
// ════════════════════════════════════════════════════════════════════════════
write('10-status.svg', 'cloudferry status', [
  L(green('$'), t(' '), b(t('cloudferry status'))),
  L(b(t('Job dropbox-to-gdrive-20260613-162600'))),
  L(dim('──────────────────────────────────────────────────')),
  L(t('  Route       jane@example.com → jane@gmail.com')),
  L(t('  Source root /Photos')),
  L(t('  Dest root   root')),
  L(t('  Discovery   '), green('complete')),
  BLANK,
  L(t('  Files       23,910 total')),
  L(t('    '), green('done'), t('      23,908  (271.0 GB)')),
  L(t('    pending   0')),
  L(t('    '), red('failed'), t('    2')),
  L(t('  Data        271.0 GB / 271.0 GB')),
  BLANK,
  L(b(t('  Failures:'))),
  L(t('    '), red('✗'), t(' Photos/locked.key '), dim('— HTTP 403 for .../download: insufficient_scope')),
  L(t('    '), red('✗'), t(' Photos/corrupt.raw '), dim('— size mismatch after download')),
]);

console.log('\nAll screenshots written to', path.relative(process.cwd(), OUT));
