// The setup window's page: buttons ask the main process to act; ticks follow the state it reports.
import type { SetupBridge } from './setup-preload.ts';
import type { SetupState } from './setup.ts';

const setup = (window as unknown as { setup: SetupBridge }).setup;
const field = (id: string) => document.getElementById(id) as HTMLInputElement;

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-act]')) {
  button.addEventListener('click', () => setup.act(button.dataset.act as Parameters<SetupBridge['act']>[0]));
}
document.querySelector('button[data-keys]')!.addEventListener('click', () => setup.saveKeys(field('nvidia').value, field('groq').value));
document.getElementById('finish')!.addEventListener('click', () => setup.finish(field('login').checked));

setup.onState((state: SetupState) => {
  for (const [step, done] of Object.entries(state)) {
    const row = document.getElementById(step);
    row?.classList.toggle('done', done);
    const tick = row?.querySelector('.tick');
    if (tick && done) tick.textContent = '✓';
  }
  // Jarvis cannot work without keys and the microphone; the rest can wait.
  (document.getElementById('finish') as HTMLButtonElement).disabled = !(state.keys && state.microphone);
});
