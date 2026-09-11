/**
 * @vitest-environment jsdom
 *
 * `vitest.config.ts` runs `src/**` in a node environment, which is right for the pure modules that
 * make up most of this directory. `isLeavingWall` reads a real MouseEvent's target and walks up to
 * its anchor, so this one file needs a DOM. Scoped here rather than flipping the project default,
 * which would slow every other suite down for one file's sake.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  closeAllConnections,
  isLeavingSection,
  openConnectionCount,
  registerConnectionCloser,
} from './nav-teardown';

/** A click on an anchor built from `html`, with `init` overriding button/modifier state. */
function clickOn(html: string, init: Partial<MouseEventInit> = {}): MouseEvent {
  document.body.innerHTML = html;
  const anchor = document.querySelector('a');
  if (anchor === null) throw new Error('fixture has no anchor');
  const event = new MouseEvent('click', { bubbles: true, button: 0, ...init });
  // `target` is read-only on a synthetic event until it is dispatched, so dispatch it.
  anchor.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  closeAllConnections();
  document.body.innerHTML = '';
});

describe('the player registry', () => {
  it('closes every registered player and reports how many', () => {
    const closed: string[] = [];
    registerConnectionCloser(() => closed.push('a'));
    registerConnectionCloser(() => closed.push('b'));
    expect(openConnectionCount()).toBe(2);

    expect(closeAllConnections()).toBe(2);
    expect(closed).toEqual(['a', 'b']);
    expect(openConnectionCount()).toBe(0);
  });

  it('is idempotent — closing twice is harmless and closes nothing the second time', () => {
    let calls = 0;
    registerConnectionCloser(() => {
      calls += 1;
    });
    expect(closeAllConnections()).toBe(1);
    expect(closeAllConnections()).toBe(0);
    expect(calls).toBe(1);
  });

  it('is safe with no players open', () => {
    expect(() => closeAllConnections()).not.toThrow();
    expect(closeAllConnections()).toBe(0);
  });

  it('deregisters, so an unmounted player is not closed again on the next navigation', () => {
    let calls = 0;
    const deregister = registerConnectionCloser(() => {
      calls += 1;
    });
    deregister();
    closeAllConnections();
    expect(calls).toBe(0);
  });

  it('one failing closer does not strand the others — a half-released pool is the bug being fixed', () => {
    const closed: string[] = [];
    registerConnectionCloser(() => {
      throw new Error('this player is wedged');
    });
    registerConnectionCloser(() => closed.push('survivor'));

    expect(() => closeAllConnections()).not.toThrow();
    expect(closed).toEqual(['survivor']);
  });

  it('a closer that deregisters itself mid-close cannot corrupt the iteration', () => {
    const closed: string[] = [];
    // This is exactly what use-hls-player does: its effect cleanup deregisters, and the cleanup is
    // triggered by React right after the closer runs.
    const deregister = registerConnectionCloser(() => {
      deregister();
      closed.push('self-deregistering');
    });
    registerConnectionCloser(() => closed.push('other'));

    expect(closeAllConnections()).toBe(2);
    expect(closed).toEqual(['self-deregistering', 'other']);
  });
});

describe('deciding whether a click is leaving the wall', () => {
  it('fires for a plain left-click on a same-origin link elsewhere', () => {
    expect(isLeavingSection(clickOn('<a href="/trace">Trace</a>'), '/video-wall')).toBe(true);
  });

  it('ignores a link back to the wall itself — that is a tile swap, not a departure', () => {
    expect(isLeavingSection(clickOn('<a href="/video-wall">Wall</a>'), '/video-wall')).toBe(false);
  });

  it('ignores wall sub-paths, so opening a single camera keeps the grid alive', () => {
    expect(
      isLeavingSection(clickOn('<a href="/video-wall/stream/cam01">cam01</a>'), '/video-wall'),
    ).toBe(false);
  });

  it('ignores a query-only change on the wall, which is how a camera is selected', () => {
    expect(
      isLeavingSection(clickOn('<a href="/video-wall?camera=abc">preview</a>'), '/video-wall'),
    ).toBe(false);
  });

  it.each([
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
  ])('ignores a %s-click, which opens a new tab and leaves this page playing', (_name, init) => {
    expect(isLeavingSection(clickOn('<a href="/trace">Trace</a>', init), '/video-wall')).toBe(
      false,
    );
  });

  it('ignores a middle-click', () => {
    expect(
      isLeavingSection(clickOn('<a href="/trace">Trace</a>', { button: 1 }), '/video-wall'),
    ).toBe(false);
  });

  it('ignores target="_blank"', () => {
    expect(
      isLeavingSection(clickOn('<a href="/trace" target="_blank">Trace</a>'), '/video-wall'),
    ).toBe(false);
  });

  it('ignores a download link', () => {
    expect(
      isLeavingSection(clickOn('<a href="/report.pdf" download>Report</a>'), '/video-wall'),
    ).toBe(false);
  });

  it('ignores another origin, which is not a client-side navigation at all', () => {
    expect(
      isLeavingSection(clickOn('<a href="https://example.com/x">Out</a>'), '/video-wall'),
    ).toBe(false);
  });

  it('ignores a bare hash link', () => {
    expect(isLeavingSection(clickOn('<a href="#main">Skip</a>'), '/video-wall')).toBe(false);
  });

  it('ignores a click that something else already handled', () => {
    document.body.innerHTML = '<a href="/trace">Trace</a>';
    const anchor = document.querySelector('a');
    if (anchor === null) throw new Error('no anchor');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.addEventListener('click', (e) => e.preventDefault(), { once: true });
    anchor.dispatchEvent(event);
    expect(isLeavingSection(event, '/video-wall')).toBe(false);
  });

  it('finds the anchor when the click lands on a child element inside the link', () => {
    expect(
      isLeavingSection(clickOn('<a href="/alerts"><span>Alerts</span></a>'), '/video-wall'),
    ).toBe(true);
  });

  it('ignores a click that is not on a link at all', () => {
    document.body.innerHTML = '<button type="button">Not a link</button>';
    const button = document.querySelector('button');
    if (button === null) throw new Error('no button');
    const event = new MouseEvent('click', { bubbles: true, button: 0 });
    button.dispatchEvent(event);
    expect(isLeavingSection(event, '/video-wall')).toBe(false);
  });
});
