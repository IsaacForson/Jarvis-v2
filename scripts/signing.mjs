// A permanent signing identity for Jarvis, made once on this Mac. macOS remembers permissions
// (Microphone, Accessibility, Screen Recording) by the app's signature; an ad-hoc signature changes
// with every build, so each rebuild made macOS forget them. Signed with the same certificate every
// time, Jarvis keeps its permissions across rebuilds. The certificate is self-made, not Apple's: fine
// on this Mac; on another Mac it opens with right-click, Open, the first time.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const IDENTITY = 'Jarvis Local Signing';
const folder = join(homedir(), 'Library/Application Support/Jarvis Signing');
const keychain = join(folder, 'signing.keychain-db');
const passwordFile = join(folder, 'keychain-password');
const quiet = (file, args) => execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** Makes the certificate and its own keychain the first time; afterwards just unlocks the keychain. */
export function ensureIdentity() {
  if (existsSync(keychain) && existsSync(passwordFile)) {
    quiet('security', ['unlock-keychain', '-p', readFileSync(passwordFile, 'utf8'), keychain]);
    return { identity: IDENTITY, keychain };
  }
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString('hex');
  writeFileSync(passwordFile, password, { mode: 0o600 });
  const work = mkdtempSync(join(tmpdir(), 'jarvis-sign-'));
  try {
    writeFileSync(
      join(work, 'cert.cnf'),
      `[ req ]\ndistinguished_name = dn\nx509_extensions = ext\nprompt = no\n[ dn ]\nCN = ${IDENTITY}\n[ ext ]\nbasicConstraints = critical,CA:false\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = critical,codeSigning\n`,
    );
    quiet('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem'), '-days', '7300', '-config', join(work, 'cert.cnf')]);
    quiet('openssl', ['pkcs12', '-export', '-inkey', join(work, 'key.pem'), '-in', join(work, 'cert.pem'), '-out', join(work, 'id.p12'), '-passout', `pass:${password}`, '-name', IDENTITY]);
    rmSync(keychain, { force: true });
    quiet('security', ['create-keychain', '-p', password, keychain]);
    quiet('security', ['set-keychain-settings', keychain]); // no auto-lock timeout
    quiet('security', ['unlock-keychain', '-p', password, keychain]);
    quiet('security', ['import', join(work, 'id.p12'), '-k', keychain, '-P', password, '-T', '/usr/bin/codesign']);
    // Lets codesign use the key without a password dialog.
    quiet('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain]);
  } finally {
    rmSync(work, { recursive: true, force: true }); // the private key now lives only in the keychain
  }
  chmodSync(keychain, 0o600);
  return { identity: IDENTITY, keychain };
}

/** Signs an app (and everything inside it) with the permanent identity. */
export function sign(path) {
  const { identity, keychain: chain } = ensureIdentity();
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, '--keychain', chain, path], { stdio: ['ignore', 'ignore', 'inherit'] });
}
