import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setStartAtLogin } from './login.ts';

test('starting at login writes a valid launch agent for this project, and stopping removes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-login-'));
  const file = join(dir, 'LaunchAgents', 'agent.plist');
  try {
    await setStartAtLogin(true, '/Apps/Electron & Co/Electron', '/Users/me/jarvis', file);
    execFileSync('plutil', ['-lint', file]);
    const plist = await readFile(file, 'utf8');
    assert.match(plist, /<string>\/Apps\/Electron &amp; Co\/Electron<\/string><string>\/Users\/me\/jarvis<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    await setStartAtLogin(false, '', '', file);
    assert.equal(existsSync(file), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
