import { describe, expect, it } from 'vitest';

import { createWireNoteMemory } from '../wireNoteMemory';

const UI = '[UI language] zh-CN';
const PHONE = '[客户端说明] 手机';
const PC = '[客户端说明] 另一台电脑';

describe('wireNoteMemory', () => {
  it('sends every note the first time and nothing unchanged afterwards', () => {
    const memory = createWireNoteMemory();
    const first = memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE });
    expect(first.notes).toEqual({ 'ui-language': UI, 'client-environment': PHONE });
    first.commit();

    const second = memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE });
    expect(second.notes).toEqual({});
  });

  it('resends only the note whose content changed', () => {
    const memory = createWireNoteMemory();
    memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }).commit();

    const switched = memory.plan('s1', { 'ui-language': UI, 'client-environment': PC });
    expect(switched.notes).toEqual({ 'client-environment': PC });
    switched.commit();
    expect(memory.plan('s1', { 'ui-language': UI, 'client-environment': PC }).notes).toEqual({});
  });

  it('remembers an absent note so its return is sent again', () => {
    const memory = createWireNoteMemory();
    memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }).commit();
    const local = memory.plan('s1', { 'ui-language': UI, 'client-environment': null });
    expect(local.notes).toEqual({});
    local.commit();
    expect(memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }).notes).toEqual({
      'client-environment': PHONE,
    });
  });

  it('does not treat an uncommitted (rejected) send as delivered', () => {
    const memory = createWireNoteMemory();
    memory.plan('s1', { 'ui-language': UI });
    expect(memory.plan('s1', { 'ui-language': UI }).notes).toEqual({ 'ui-language': UI });
  });

  it('resends everything when forced (handoff first turn) or after reset (compact / clear)', () => {
    const memory = createWireNoteMemory();
    memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }).commit();

    expect(memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }, { force: true }).notes)
      .toEqual({ 'ui-language': UI, 'client-environment': PHONE });

    memory.reset('s1');
    expect(memory.plan('s1', { 'ui-language': UI, 'client-environment': PHONE }).notes)
      .toEqual({ 'ui-language': UI, 'client-environment': PHONE });
  });

  it('keeps sessions independent', () => {
    const memory = createWireNoteMemory();
    memory.plan('s1', { 'ui-language': UI }).commit();
    expect(memory.plan('s2', { 'ui-language': UI }).notes).toEqual({ 'ui-language': UI });
  });
});
