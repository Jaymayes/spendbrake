// lock-store.mjs — the file I/O behind scripts/lock.mjs: read a lock file, write it, and acquire (read → decide →
// write) so that two sessions racing for one free resource cannot both win.
import { readFileSync, writeFileSync, openSync, closeSync, renameSync } from 'node:fs';
import { parseLock, decideLock } from './locks.mjs';

/** The lock at `path`, null if there is none. An unreadable file is held (parseLock's rule). */
export function readLock(path) {
  try { return parseLock(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; return parseLock(''); }
}

/** exclusive: create-only (O_EXCL), throws EEXIST if the file appeared. Otherwise replace via rename. */
export function writeLock(path, lock, exclusive) {
  const body = JSON.stringify(lock, null, 2) + '\n';
  if (exclusive) {
    const fd = openSync(path, 'wx');
    try { writeFileSync(fd, body); } finally { closeSync(fd); }
    return;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

/**
 * Read, decide, write. A free resource is created with O_EXCL, so if another session created it between our read
 * and our write, we lose cleanly instead of overwriting its lock. `afterRead` exists for tests to open that window.
 * @returns {{ ok: boolean, lock?: object, reason: string }}
 */
export function acquire(path, req, now, { afterRead } = {}) {
  const existing = readLock(path);
  if (afterRead) afterRead();
  const d = decideLock(existing, req, now);
  if (d.action === 'refuse') return { ok: false, reason: d.reason };
  try {
    writeLock(path, d.lock, d.action === 'create');
  } catch (e) {
    if (e.code === 'EEXIST') return { ok: false, reason: 'another session took it a moment ago; run status' };
    throw e;
  }
  return { ok: true, lock: d.lock, reason: d.reason };
}
