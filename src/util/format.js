'use strict';

// Human-friendly formatting helpers used across the UI and logs.

function formatBytes(bytes, decimals = 1) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  const d = i === 0 ? 0 : decimals;
  return `${value.toFixed(d)} ${units[i]}`;
}

// Bytes per second -> "12.3 MB/s"
function formatRate(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 1) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

// Seconds -> "HH:MM:SS" (or "--:--:--" when unknown).
function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '--:--:--';
  }
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatNumber(n) {
  if (n === null || n === undefined) return '0';
  return Number(n).toLocaleString('en-US');
}

// Truncate a string to width, with a middle ellipsis so the file extension
// stays visible. Pads to exactly `width` when `pad` is true.
function fit(str, width, pad = false) {
  str = String(str == null ? '' : str);
  if (str.length > width) {
    if (width <= 1) {
      str = str.slice(0, width);
    } else {
      const keepEnd = Math.max(3, Math.floor(width * 0.35));
      const keepStart = width - 1 - keepEnd;
      str = `${str.slice(0, keepStart)}…${str.slice(str.length - keepEnd)}`;
    }
  }
  if (pad && str.length < width) str = str + ' '.repeat(width - str.length);
  return str;
}

module.exports = { formatBytes, formatRate, formatDuration, formatNumber, fit };
