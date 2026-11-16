// The entrypoint: bind an ephemeral port, register it with the trial environment,
// then wait for the environment to say the trial is done.
//
// Lifecycle (per the rules): the program binds port 0, POSTs {"port": N} to
// $MAKEFUN_ENV_URL/register, long-polls GET $MAKEFUN_ENV_URL/done until it answers
// {"done": true}, and exits 0. A register answer of 200 or 409 is a success; 400 or
// 405 is fatal; anything else is retried with exponential backoff. The program
// never binds 8080. When MAKEFUN_ENV_URL is unset (a local run), the server simply
// stays up on its port and prints where it listens, so the kit's runner can reach it.

import { createServer } from './app.ts';
import { Store } from './store.ts';

const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}/register`;
  let delayMs = 500;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch {
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 8000);
      continue;
    }
    if (response.status === 200 || response.status === 409) return;
    if (response.status === 400 || response.status === 405) {
      throw new Error(`register rejected the port with HTTP ${response.status}`);
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 8000);
  }
  throw new Error('register did not succeed after 30 attempts');
}

async function waitDone(): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}/done`;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The environment is not reachable yet; keep polling.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const store = new Store();
  const server = createServer({ store, token });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind a port'));
        return;
      }
      resolve(address.port);
    });
  });
  if (envUrl === '') {
    console.log(`forge listening on http://127.0.0.1:${port} (no MAKEFUN_ENV_URL; not registering)`);
    // A local run stays up until it is killed; the listening server keeps the
    // event loop alive, and main() must not resolve (resolving would exit).
    await new Promise(() => {});
    return;
  }
  await register(port);
  await waitDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
