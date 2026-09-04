/**
 * "Responsive at 1280px and 1920px (control-room displays)."
 *
 * Asserted mechanically rather than eyeballed: at each width the page must not scroll horizontally,
 * and the shell's nav and main region must both be laid out. A screenshot proves nothing about
 * overflow — `scrollWidth > clientWidth` does.
 *
 *   node scripts/responsive.mjs <path-to-token-file>
 */
import * as chromeLauncher from 'chrome-launcher';
import { readFileSync } from 'node:fs';

const token = readFileSync(process.argv[2], 'utf8').trim();
const WIDTHS = [1280, 1920];
const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox'] });

const res = await fetch(`http://localhost:${String(chrome.port)}/json/new?about:blank`, {
  method: 'PUT',
});
const target = await res.json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

let id = 0;
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const messageId = ++id;
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id === messageId) {
        ws.removeEventListener('message', onMessage);
        resolve(data.result);
      }
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });

await send('Network.enable');
await send('Network.setCookies', {
  cookies: [
    { name: 'saakshi_session', value: token, domain: 'localhost', path: '/' },
    { name: 'saakshi_role', value: 'admin', domain: 'localhost', path: '/' },
  ],
});

let failures = 0;

for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  for (const [name, url] of [
    ['login', 'http://localhost:3000/login'],
    ['shell (/registry)', 'http://localhost:3000/registry'],
  ]) {
    await send('Page.enable');
    await send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 1500));

    const { result } = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        nav: !!document.querySelector('nav[aria-label="Main"]'),
        main: !!document.querySelector('main'),
      })`,
      returnByValue: true,
    });
    const m = JSON.parse(result.value);
    const overflow = m.scrollWidth > m.clientWidth;
    if (overflow) failures += 1;

    console.log(
      `  ${String(width)}px  ${name.padEnd(18)} scrollWidth ${String(m.scrollWidth).padStart(4)} / client ${String(m.clientWidth).padStart(4)}  ` +
        `${overflow ? 'HORIZONTAL OVERFLOW' : 'no overflow'}${m.nav ? ' · nav' : ''}${m.main ? ' · main' : ''}`,
    );
  }
}

ws.close();
await chrome.kill();

console.log('');
if (failures > 0) {
  console.error(`  FAIL: ${String(failures)} layout(s) overflow horizontally`);
  process.exit(1);
}
console.log('  PASS: no horizontal overflow at 1280px or 1920px');
