import { describe, expect, it } from 'vitest';
import { parseCameraEdit } from './camera-edit';

const VALID: Record<string, string> = {
  name: 'Ashram Road junction',
  lat: '23.0225',
  lon: '72.5714',
  address: '',
  district: 'Ahmedabad',
  cameraType: 'ip',
  mount: 'static',
  geometryClass: 'anpr_viable',
  adapterKind: 'hls',
  vendor: 'Hikvision',
  vmsPlatform: '',
  retentionDays: '30',
  storageType: 'local',
};

const form = (overrides: Record<string, string> = {}) => {
  const values = { ...VALID, ...overrides };
  return (name: string) => values[name] ?? '';
};

describe('parseCameraEdit (D4-20)', () => {
  it('parses a valid form into a PATCH body, blanks as null', () => {
    const result = parseCameraEdit(form());
    expect(result).toEqual({
      ok: true,
      body: {
        name: 'Ashram Road junction',
        lat: 23.0225,
        lon: 72.5714,
        address: null,
        district: 'Ahmedabad',
        cameraType: 'ip',
        mount: 'static',
        geometryClass: 'anpr_viable',
        adapterKind: 'hls',
        vendor: 'Hikvision',
        vmsPlatform: null,
        retentionDays: 30,
        storageType: 'local',
      },
    });
  });

  it('omits coordinates when both are blank, rather than clearing them', () => {
    const result = parseCameraEdit(form({ lat: '', lon: '' }));
    expect(result.ok && 'lat' in result.body).toBe(false);
  });

  it('flags an out-of-range latitude and longitude inline', () => {
    const result = parseCameraEdit(form({ lat: '123', lon: '-200' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual(['lat', 'lon']);
  });

  it('flags one coordinate without the other', () => {
    const result = parseCameraEdit(form({ lon: '' }));
    expect(result.ok ? null : result.fieldErrors['lon']).toMatch(/longitude/i);
  });

  it('flags a negative or fractional retention', () => {
    for (const retentionDays of ['-1', '2.5', 'abc']) {
      const result = parseCameraEdit(form({ retentionDays }));
      expect(result.ok ? null : Object.keys(result.fieldErrors)).toEqual(['retentionDays']);
    }
  });

  it('requires a name and rejects values outside the enums', () => {
    const result = parseCameraEdit(form({ name: '', adapterKind: 'ftp', storageType: 'tape' }));
    expect(result.ok ? null : Object.keys(result.fieldErrors).sort()).toEqual([
      'adapterKind',
      'name',
      'storageType',
    ]);
  });
});
