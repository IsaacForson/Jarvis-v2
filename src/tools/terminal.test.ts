import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandApproval, terminalTools } from './terminal.ts';

const run = terminalTools[0]!;

test('commands that only look run without asking', () => {
  for (const command of ['ls -la ~/Desktop', 'pwd', 'date', 'df -h']) assert.equal(commandApproval(command), undefined, command);
});

test('anything that could change something is confirmed first', () => {
  for (const command of ['rm notes.txt', 'git push', 'brew install jq', 'ls; rm -rf ~', 'ls | xargs rm', 'date > file', 'ls $(rm x)', 'ls `rm x`', 'ls && rm x']) {
    assert.match(commandApproval(command) ?? '', /^run the command: /, command);
  }
});

test('a real read-only command returns its output', async () => {
  assert.match(await run.run({ command: 'whoami' }), /\w+/);
});

test('sudo is refused outright, and a failing command reports why', async () => {
  await assert.rejects(run.run({ command: 'sudo rm -rf /' }), /sudo/);
  await assert.rejects(run.run({ command: 'echo hi && sudo ls' }), /sudo/);
  await assert.rejects(run.run({ command: 'ls /definitely/not/here' }), /No such file/);
  for (const command of ['cat ~/project/.env', 'cat ~/.ssh/id_ed25519', 'security find-generic-password -a me', 'cp server.pem /tmp']) await assert.rejects(run.run({ command }), /keys or passwords/, command);
});
