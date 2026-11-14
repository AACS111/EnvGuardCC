import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, lstatSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// One writer (the host) owns these files. Never share its handle with cmd redirection.
export function createRotatingLog(file, { maxBytes = 5 * 1024 * 1024, backups = 2,
  now = () => new Date(), onError = () => {} } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 256 || !Number.isInteger(backups) || backups < 1 || backups > 10) throw new Error('Invalid log retention limits');
  let reported = false;
  function regular(target) {
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Unsafe log file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return line => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      for (let i = 0; i <= backups; i++) regular(i ? `${file}.${i}` : file);
      // Bound individual records too, including stack traces and malformed kernel output.
      let message = `${now().toISOString()} ${String(line).replace(/[\r\n]+/g, ' ')}\n`;
      if (Buffer.byteLength(message) > maxBytes) {
        message = Buffer.from(message).subarray(0, Math.max(0, maxBytes - 32)).toString('utf8') + ' [truncated]\n';
      }
      let size = 0;
      try { size = statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size + Buffer.byteLength(message) > maxBytes) {
        rmSync(`${file}.${backups}`, { force: true });
        for (let i = backups - 1; i >= 0; i--) {
          try { renameSync(i ? `${file}.${i}` : file, `${file}.${i + 1}`); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        // Retain the most recent complete lines of oversized legacy logs.
        if (size > maxBytes) {
          const archive = `${file}.1`;
          const fd = openSync(archive, 'r');
          const tail = Buffer.alloc(maxBytes);
          let length;
          try { length = readSync(fd, tail, 0, tail.length, size - maxBytes); }
          finally { closeSync(fd); }
          const start = tail.indexOf(10);
          writeFileSync(archive, tail.subarray(start >= 0 ? start + 1 : 0, length));
        }
      }
      appendFileSync(file, message, { encoding: 'utf8', mode: 0o600 });
      reported = false;
    } catch (error) {
      // Logging failure must never interrupt network recovery or itself flood stderr.
      if (!reported) {
        reported = true;
        try { onError(error); } catch { /* Even the fallback sink may be unavailable. */ }
      }
    }
  };
}
