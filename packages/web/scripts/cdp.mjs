/**
 * A small Chrome DevTools Protocol client, shared by the registry verification scripts.
 *
 * The repo already drives Chrome this way in `a11y.mjs` and `responsive.mjs`; this factors the
 * plumbing out so the D1-08 scripts can spend their lines on assertions instead of WebSocket
 * bookkeeping. No Puppeteer: `chrome-launcher` is already a dependency and Node 22 has a global
 * `WebSocket`, so the whole client is sixty lines and adds nothing to install.
 *
 * Why CDP at all, rather than jsdom: the acceptance criteria are about a **WebGL map** and about
 * **what the network tab shows**. Neither exists outside a real browser, and a test that asserts on
 * a mocked MapLibre would prove only that the mock was written to agree with the test.
 */
import * as chromeLauncher from 'chrome-launcher';

export async function openBrowser({ headless = true, width = 1600, height = 1000 } = {}) {
  const chrome = await chromeLauncher.launch({
    chromeFlags: [
      ...(headless ? ['--headless=new'] : []),
      '--no-sandbox',
      '--disable-gpu-sandbox',
      // Software WebGL: a headless container has no GPU, and without this MapLibre fails to get a
      // context and renders nothing at all — silently.
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      `--window-size=${String(width)},${String(height)}`,
    ],
  });

  const target = await fetch(`http://localhost:${String(chrome.port)}/json/new?about:blank`, {
    method: 'PUT',
  }).then((r) => r.json());

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const listeners = new Set();

  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.method !== undefined) for (const listener of listeners) listener(data);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const messageId = ++id;
      const onMessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id !== messageId) return;
        ws.removeEventListener('message', onMessage);
        if (data.error !== undefined) reject(new Error(`${method}: ${data.error.message}`));
        else resolve(data.result);
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  const on = (method, handler) => {
    const listener = (message) => {
      if (message.method === method) handler(message.params);
    };
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  /** Evaluate in the page and return the value. Throws with the page's own error message. */
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails !== undefined) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  };

  const close = async () => {
    ws.close();
    await chrome.kill();
  };

  return { chrome, ws, send, on, evaluate, close };
}

/** Sets the session cookies the app's middleware requires. */
export async function authenticate(cdp, token, role = 'admin', origin = 'http://localhost:3100') {
  const { hostname } = new URL(origin);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCookies', {
    cookies: [
      { name: 'saakshi_session', value: token, domain: hostname, path: '/' },
      { name: 'saakshi_role', value: role, domain: hostname, path: '/' },
    ],
  });
}

/** Navigate and wait for the load event, with a timeout that fails loudly rather than hanging. */
export async function navigate(cdp, url, { timeoutMs = 30000 } = {}) {
  await cdp.send('Page.enable');
  const loaded = new Promise((resolve, reject) => {
    const off = cdp.on('Page.loadEventFired', () => {
      off();
      resolve();
    });
    setTimeout(() => {
      off();
      reject(new Error(`timed out loading ${url}`));
    }, timeoutMs);
  });
  await cdp.send('Page.navigate', { url });
  await loaded;
}

/** Poll an expression until it is truthy. The alternative is a sleep long enough to be flaky. */
export async function waitFor(cdp, expression, { timeoutMs = 30000, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cdp.evaluate(expression);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Wait until the map instance exists, has loaded its style, and has gone idle. */
export const MAP_READY = `(() => {
  const m = window.__saakshiMap;
  return m !== undefined && m.loaded() && m.getSource('cameras') !== undefined;
})()`;

export async function screenshot(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

export function pass(message) {
  console.log(`  ✓ ${message}`);
}

export function fail(message) {
  console.error(`  ✗ ${message}`);
  process.exitCode = 1;
}

export function check(condition, message) {
  if (condition) pass(message);
  else fail(message);
  return Boolean(condition);
}
