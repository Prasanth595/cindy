import { afterEach, expect, it, vi } from 'vitest';
import { validateSkillAudience } from '../skillhubAudience';

afterEach(() => vi.restoreAllMocks());
it('accepts the server ISO version unchanged', () => {
  expect(() => validateSkillAudience({ expectedUpdatedAt: '2026-10-14T09:00:00.123Z' })).not.toThrow();
});
it.each(['x'.repeat(100000), '2026-10-14', '2026-10-14T09:00:00.000+00:00'])('rejects unbounded or noncanonical versions before parsing (%#)', (value) => {
  const parse = vi.spyOn(Date, 'parse');
  expect(() => validateSkillAudience({ expectedUpdatedAt: value })).toThrow('Invalid audience version');
  expect(parse).not.toHaveBeenCalled();
});
it('rejects invalid ISO date values', () => {
  expect(() => validateSkillAudience({ expectedUpdatedAt: '2026-99-14T09:00:00.123Z' })).toThrow('Invalid audience version');
});

it.each(['departments', 'all'] as const)('rejects %s mode without explicit IDs', (audienceMode) => {
  expect(() => validateSkillAudience({ audienceMode })).toThrow('Invalid department selection');
});
it('accepts explicit audience pairs and legacy absence', () => {
  expect(() => validateSkillAudience({})).not.toThrow();
  expect(() => validateSkillAudience({ audienceMode: 'all', visibilityDepartmentIds: [] })).not.toThrow();
  expect(() => validateSkillAudience({ audienceMode: 'departments', visibilityDepartmentIds: ['dept-1'] })).not.toThrow();
});

it('rejects sparse department arrays including structured cloned holes', () => {
  const sparse = new Array<string>(2); sparse[1] = 'dept-1';
  for (const ids of [new Array<string>(1), sparse, structuredClone(sparse)]) {
    expect(() => validateSkillAudience({ audienceMode: 'departments', visibilityDepartmentIds: ids })).toThrow('Invalid department selection');
  }
});
