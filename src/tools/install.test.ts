import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findCask, installTools, type Brew } from './install.ts';

const casks = {
  vlc: { token: 'vlc', name: ['VLC media player'], desc: 'Multimedia player', installed: null, artifacts: [{ app: ['VLC.app'] }] },
  zoom: { token: 'zoom', name: ['Zoom'], desc: 'Video calls', installed: null, artifacts: [{ app: ['zoom.us.app'] }] },
  'vlc-setup': { token: 'vlc-setup', name: ['VLC Setup'], desc: 'Installer', installed: null },
  'visual-studio-code': { token: 'visual-studio-code', name: ['Microsoft Visual Studio Code'], desc: 'Code editor', installed: '1.95' },
};
const fake = (calls: string[][]): Brew => async (args) => {
  calls.push(args);
  if (args[0] === 'search') return args[2] === 'nothing' ? '' : args[2] === 'visual studio code' ? 'visual-studio-code\n' : args[2] === 'zoom' ? 'zoom\n' : 'vlc\nvlc-setup\n';
  if (args[0] === 'info') return JSON.stringify({ casks: args.slice(3).map((token) => casks[token as keyof typeof casks]) });
  return '';
};

test('the right app is picked and installed, an installed one is left alone, and a missing one points to the App Store', async () => {
  const calls: string[][] = [];
  assert.equal((await findCask('VLC', fake(calls)))?.token, 'vlc');
  const install = installTools(fake(calls), '/nonexistent')[0]!;
  assert.equal(install.approval?.({ name: 'VLC' }), 'download and install VLC');
  assert.equal(await install.run({ name: 'VLC' }), 'Installed VLC media player (Multimedia player). It is in the Applications folder; open it with open_app.');
  assert.deepEqual(calls.at(-1), ['install', '--cask', 'vlc']);
  assert.match(await install.run({ name: 'visual studio code' }), /already installed/);
  await assert.rejects(install.run({ name: 'nothing' }), /App Store/);
});

test('an app already in Applications, installed by hand, is not installed again', async () => {
  const calls: string[][] = [];
  const apps = await mkdtemp(join(tmpdir(), 'jarvis-apps-'));
  await mkdir(join(apps, 'zoom.us.app'));
  try {
    assert.match(await installTools(fake(calls), apps)[0]!.run({ name: 'zoom' }), /Zoom \(Video calls\) is already installed/);
    assert.ok(!calls.some((call) => call[0] === 'install'));
  } finally {
    await rm(apps, { recursive: true, force: true });
  }
});

test('an install that needs the password says how he can do it', async () => {
  const brew: Brew = async (args) => {
    if (args[0] === 'install') throw new Error('sudo: a terminal is required to read the password');
    return fake([])(args);
  };
  await assert.rejects(installTools(brew, '/nonexistent')[0]!.run({ name: 'VLC' }), /administrator password\. He can run: brew install --cask vlc/);
});
