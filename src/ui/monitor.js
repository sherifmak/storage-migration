'use strict';

const { c, ctl, visibleLength } = require('../util/ansi');
const { formatBytes, formatRate, formatDuration, formatNumber, fit } = require('../util/format');

// Live terminal dashboard. On a TTY it redraws a boxed, colourised monitor in
// place; otherwise it falls back to periodic one-line status updates so logs
// stay readable (CI, piped output, `nohup`, etc.).
class Monitor {
  constructor(engine, { from, to } = {}) {
    this.engine = engine;
    this.from = from || 'source';
    this.to = to || 'destination';
    this.timer = null;
    this.phase = 'starting';
    this.isTTY = Boolean(process.stdout.isTTY);
    engine.on('phase', (p) => { this.phase = p; });
  }

  start() {
    if (this.isTTY) {
      ctl.hideCursor();
      ctl.clearScreen();
      this.timer = setInterval(() => this._renderTTY(), 250);
    } else {
      this._line('starting…');
      this.timer = setInterval(() => this._renderPlain(), 3000);
    }
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.isTTY) {
      this._renderTTY();
      ctl.showCursor();
      process.stdout.write('\n');
    }
  }

  // ---- plain (non-TTY) -----------------------------------------------------

  _renderPlain() {
    const s = this.engine.stats();
    if (this.phase === 'discovery') return this._line(`discovering… ${formatNumber(s.discovered)} items found`);
    const pct = s.bytesTotal ? Math.floor((s.bytesDone / s.bytesTotal) * 100) : 0;
    this._line(`${pct}%  ${formatNumber(s.done)}/${formatNumber(s.filesTotal)} files  ` +
      `${formatBytes(s.bytesDone)}/${formatBytes(s.bytesTotal)}  ${formatRate(s.rate)}  ` +
      `ETA ${formatDuration(s.eta)}  (failed ${s.failed})`);
  }

  _line(msg) { process.stdout.write(`[cloudferry] ${msg}\n`); }

  // ---- TTY dashboard -------------------------------------------------------

  _renderTTY() {
    const width = Math.min(100, Math.max(60, process.stdout.columns || 80));
    const inner = width - 4; // account for "║ " … " ║"
    const s = this.engine.stats();
    const lines = [];

    const title = `${c.bold(c.cyan('CloudFerry'))}  ${c.dim('·')}  ${c.bold(this.from)} ${c.cyan('→')} ${c.bold(this.to)}`;
    lines.push(this._row(title, inner));
    lines.push(this._sep(inner));

    if (this.phase === 'discovery' && !s.discoveryComplete) {
      lines.push(this._row(`${spinner()} Scanning source… ${c.bold(formatNumber(s.discovered))} items found`, inner));
      lines.push(this._row(c.dim('Building the migration manifest before transferring.'), inner));
    } else {
      const pct = s.bytesTotal ? s.bytesDone / s.bytesTotal : (s.filesTotal ? s.done / s.filesTotal : 0);
      lines.push(this._row(`${c.bold('Overall')}  ${bar(pct, Math.max(20, inner - 24))} ${String(Math.floor(pct * 100)).padStart(3)}%`, inner));
      lines.push(this._row(
        `${c.dim('Files')} ${formatNumber(s.done)}${c.dim('/')}${formatNumber(s.filesTotal)}` +
        `      ${c.dim('Data')} ${formatBytes(s.bytesDone)}${c.dim('/')}${formatBytes(s.bytesTotal)}`, inner));
      lines.push(this._row(
        `${c.dim('Speed')} ${c.green(formatRate(s.rate))}   ${c.dim('·')}   ${c.dim('ETA')} ${formatDuration(s.eta)}` +
        `   ${c.dim('·')}   ${c.dim('Elapsed')} ${formatDuration(s.elapsed)}`, inner));
      lines.push(this._row(
        `${c.dim('Active')} ${s.active}   ${c.dim('Failed')} ${s.failed ? c.red(s.failed) : 0}` +
        `   ${c.dim('Skipped')} ${s.skipped}   ${c.dim('Pending')} ${formatNumber(s.pending)}`, inner));
    }

    lines.push(this._sectionSep('Workers', inner));
    for (const w of this.engine.workers) lines.push(this._row(this._worker(w, inner), inner));

    if (this.engine.recent.length) {
      lines.push(this._sectionSep('Recent', inner));
      for (const r of this.engine.recent.slice(0, 4)) lines.push(this._row(this._recent(r, inner), inner));
    }

    // Frame.
    const top = '╔' + '═'.repeat(width - 2) + '╗';
    const bottom = '╚' + '═'.repeat(width - 2) + '╝';
    const footer = c.dim('  Press Ctrl-C to pause safely — progress is saved, resume anytime.');

    const out = [ctl.home, top, ...lines, bottom, footer]
      .map((l) => ctl.clearLine + l)
      .join('\n');
    process.stdout.write(out + '\x1b[J');
  }

  _worker(w, inner) {
    if (w.idle) return c.dim(`${w.id}  idle`);
    const icon = w.phase === 'download' ? c.cyan('⬇') : w.phase === 'upload' ? c.green('⬆') : c.yellow('⊞');
    const pct = w.total ? Math.min(1, w.transferred / w.total) : 0;
    const barW = 10;
    const nameW = Math.max(10, inner - barW - 22);
    const name = fit(w.name || '', nameW, true);
    const right = w.total ? `${bar(pct, barW)} ${String(Math.floor(pct * 100)).padStart(3)}%` : bar(0, barW) + '    ';
    return `${w.id} ${icon} ${name} ${right}`;
  }

  _recent(r, inner) {
    if (r.kind === 'ok') return `${c.green('✓')} ${fit(r.name, inner - 2, false)}`;
    if (r.kind === 'skip') return `${c.dim('↷')} ${c.dim(fit(r.name + ' (already there)', inner - 2))}`;
    if (r.kind === 'retry') return `${c.yellow('⟳')} ${fit(r.name + (r.detail ? ` (${r.detail})` : ''), inner - 2)}`;
    return `${c.red('✗')} ${fit(r.name + (r.detail ? ` (${r.detail})` : ''), inner - 2)}`;
  }

  // ---- framing helpers -----------------------------------------------------

  _row(content, inner) {
    const len = visibleLength(content);
    const pad = len < inner ? ' '.repeat(inner - len) : '';
    return `║ ${content}${pad} ║`;
  }

  _sep(inner) {
    return '╟' + '─'.repeat(inner + 2) + '╢';
  }

  _sectionSep(label, inner) {
    const text = `─ ${label} `;
    const fill = '─'.repeat(Math.max(0, inner + 2 - visibleLength(text)));
    return '╟' + c.dim(text + fill) + '╢';
  }
}

function bar(fraction, width) {
  fraction = Math.max(0, Math.min(1, fraction || 0));
  const filled = Math.round(fraction * width);
  return c.green('█'.repeat(filled)) + c.dim('░'.repeat(width - filled));
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function spinner() { return c.cyan(FRAMES[Math.floor(Date.now() / 100) % FRAMES.length]); }

module.exports = { Monitor };
