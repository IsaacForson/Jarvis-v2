// Starting at login: a launch agent that opens this same app, the way `npm start` would after a build.
// Electron's own login-item setting would open bare Electron, not this project, while it is unpackaged.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LOGIN_AGENT = join(homedir(), 'Library/LaunchAgents/com.jarvis.assistant.plist');
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const launchAgent = (electron: string, project: string, label = 'com.jarvis.assistant') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(electron)}</string><string>${xml(project)}</string></array>
  <key>WorkingDirectory</key><string>${xml(project)}</string>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict>
</plist>
`;

export async function setStartAtLogin(on: boolean, electron: string, project: string, file = LOGIN_AGENT): Promise<void> {
  if (!on) return rm(file, { force: true });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, launchAgent(electron, project));
}
