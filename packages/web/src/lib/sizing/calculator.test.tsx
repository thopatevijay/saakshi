// @vitest-environment jsdom

/**
 * D3-08 AC 1 — "All inputs wired; outputs recompute live with no lag."
 *
 * Asserted by driving the real component rather than by reading it. Every input is changed and a
 * dependent output is checked to have moved, and the whole thing runs with no network stub because
 * there is no network: `computeSizing` is pure, so the recompute happens inside the render that
 * handled the keystroke. If a future edit introduces a fetch or an effect, this test starts flaking
 * and that is the point.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Calculator } from '@/app/(shell)/sizing/calculator';

afterEach(cleanup);

function panel(testId: string): HTMLElement {
  return screen.getByTestId(testId);
}

function numberInput(label: string): HTMLInputElement {
  const el = screen.getByLabelText(label, { selector: 'input[type="number"]' });
  return el as HTMLInputElement;
}

describe('the sizing calculator recomputes from its inputs (AC 1)', () => {
  it('opens on the statewide preset', () => {
    render(<Calculator />);
    expect(numberInput('Cameras').value).toBe('80000');
    expect(screen.getByRole('button', { name: 'Statewide (80,000 cameras)' })).toHaveProperty(
      'ariaPressed',
      'true',
    );
  });

  it('switches presets, including the 100,000 benchmark above the 80,000 on /problems', () => {
    render(<Calculator />);
    fireEvent.click(screen.getByRole('button', { name: 'Benchmark (100,000 cameras)' }));
    expect(numberInput('Cameras').value).toBe('100000');
    // 100,000 x 2 Mbps = 200 Gbps of central video.
    expect(panel('backhaul').textContent).toContain('200.00 Gbps');

    fireEvent.click(screen.getByRole('button', { name: 'Pilot (500 cameras)' }));
    expect(numberInput('Cameras').value).toBe('500');
  });

  it('recomputes backhaul when the camera count changes', () => {
    render(<Calculator />);
    expect(panel('backhaul').textContent).toContain('160.00 Gbps');
    fireEvent.change(numberInput('Cameras'), { target: { value: '40000' } });
    // Halving the estate halves the central-video figure, in the same render.
    expect(panel('backhaul').textContent).toContain('80.00 Gbps');
  });

  it('recomputes accelerators when ANPR coverage changes', () => {
    render(<Calculator />);
    const before = panel('compute').textContent ?? '';
    fireEvent.change(numberInput('Continuous ANPR coverage (%)'), { target: { value: '60' } });
    expect(panel('compute').textContent).not.toBe(before);
    // 60% of 80,000 = 48,000 cameras on ANPR.
    expect(panel('compute').textContent).toContain('48,000');
  });

  it('moves video back onto the backhaul when the edge split drops', () => {
    render(<Calculator />);
    fireEvent.change(numberInput('Analysed at the edge (%)'), { target: { value: '0' } });
    // Nothing at the edge: the reduction ratio collapses to 1x, which is Model 4 as written.
    expect(panel('backhaul').textContent).toContain('1.0x');
  });

  it('recomputes storage when retention changes', () => {
    render(<Calculator />);
    const before = panel('storage').textContent ?? '';
    fireEvent.change(numberInput('Metadata retention (days)'), { target: { value: '30' } });
    expect(panel('storage').textContent).not.toBe(before);
  });

  it('recomputes crops when crop retention changes', () => {
    render(<Calculator />);
    const before = panel('storage').textContent ?? '';
    fireEvent.change(numberInput('Crop retention (days)'), { target: { value: '365' } });
    expect(panel('storage').textContent).not.toBe(before);
  });

  it('recomputes when the event rate changes, and offers the measured anchors', () => {
    render(<Calculator />);
    const before = panel('storage').textContent ?? '';
    // The per-frame anchor: what the PoC write path actually emits today.
    fireEvent.click(screen.getByRole('button', { name: /Per-frame sightings, 8-camera mean/ }));
    expect(numberInput('Events per camera per day').value).toBe('923398');
    expect(panel('storage').textContent).not.toBe(before);
  });

  it('recomputes when the accelerator class changes', () => {
    render(<Calculator />);
    const before = panel('compute').textContent ?? '';
    fireEvent.change(screen.getByLabelText('Accelerator class'), {
      target: { value: 'nvidia-l4' },
    });
    // 24,000 ANPR cameras / 25 streams per L4 = 960 — PROJECT.md section 9's own figure.
    expect(panel('compute').textContent).toContain('960');
    expect(panel('compute').textContent).not.toBe(before);
  });

  it('recomputes cost when an editable unit cost is overridden', () => {
    render(<Calculator />);
    const before = panel('cost').textContent ?? '';
    fireEvent.change(numberInput('Managed backhaul capacity'), { target: { value: '4000' } });
    expect(panel('cost').textContent).not.toBe(before);
  });

  it('restores a constant default when its field is cleared', () => {
    render(<Calculator />);
    const original = panel('cost').textContent ?? '';
    const field = numberInput('Electricity tariff');
    fireEvent.change(field, { target: { value: '80' } });
    expect(panel('cost').textContent).not.toBe(original);
    fireEvent.change(field, { target: { value: '' } });
    expect(panel('cost').textContent).toBe(original);
  });

  it('never renders NaN, even when a field is cleared mid-edit', () => {
    render(<Calculator />);
    fireEvent.change(numberInput('Cameras'), { target: { value: '' } });
    expect(screen.getByTestId('outputs').textContent).not.toContain('NaN');
  });
});

describe('provenance is on the page, not only in the docs (AC 5)', () => {
  it('tags every editable constant', () => {
    render(<Calculator />);
    const chips = document.querySelectorAll('[data-provenance]');
    expect(chips.length).toBeGreaterThan(15);
    for (const chip of chips) {
      expect(['measured', 'vendor-listed', 'assumed']).toContain(chip.textContent);
    }
  });

  it('retags an overridden constant as assumed, so a reader cannot launder a guess as a measurement', () => {
    render(<Calculator />);
    const row = numberInput('Per-camera video bitrate if streamed centrally').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('assumed')).toBeTruthy();
    fireEvent.change(numberInput('Per-camera video bitrate if streamed centrally'), {
      target: { value: '4' },
    });
    expect(within(row!).getByText('assumed')).toBeTruthy();
  });
});

describe('export (AC 6)', () => {
  it('renders Markdown for the current scenario on demand', () => {
    render(<Calculator />);
    expect(screen.queryByTestId('export-markdown')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show Markdown' }));
    const md = screen.getByTestId('export-markdown').textContent ?? '';
    expect(md).toContain('# Infrastructure sizing — Statewide (80,000 cameras)');
    expect(md).toContain('## 5 · Reconciliation with `PROJECT.md` section 9');
    expect(md).not.toContain('NaN');
  });

  it('labels a modified scenario as custom rather than claiming to be the preset', () => {
    render(<Calculator />);
    fireEvent.change(numberInput('Cameras'), { target: { value: '12345' } });
    expect(screen.getByTestId('scenario-modified')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show Markdown' }));
    expect(screen.getByTestId('export-markdown').textContent).toContain(
      '# Infrastructure sizing — Custom (12,345 cameras)',
    );
  });
});
