import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Windows readers and scanners can briefly refuse atomic replacement. Keep the
 * previous complete state and retry the replacement, never delete it first. */
export async function writeState(file, body, io = fs, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try {
      await io.writeFile(file + '.tmp', body, { mode: 0o600 });
      await io.rename(file + '.tmp', file);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
      await pause(Math.min(25 * 2 ** attempt, 800));
    }
  }
}

/**
 * Best-effort owner-only access for files holding secrets. POSIX gets mode 0600 from the write
 * itself; on Windows that mode does nothing, so drop inherited ACL entries and grant only the
 * current user. Never throws: a failure leaves the file with its inherited (profile) permissions.
 */
export async function restrictToOwner(file, { platform = process.platform, run = execFileAsync } = {}) {
  if (platform !== 'win32') return false;
  const user = process.env.USERNAME;
  if (!user) return false;
  try {
    await run('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true, timeout: 10000 });
    return true;
  } catch { return false; }
}
