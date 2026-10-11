import type { KeyboardEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onReaderChoiceKey, readerChoiceIndex, readerHandReadingKey } from '../../src/web/reader-choice';

describe('keyboard movement in reader choices', () => {
  it('wraps both ways rather than trapping focus at either end', () => {
    expect(readerChoiceIndex('ArrowRight', 2, 3)).toBe(0);
    expect(readerChoiceIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(readerChoiceIndex('ArrowDown', 2, 3)).toBe(0);
    expect(readerChoiceIndex('ArrowUp', 0, 3)).toBe(2);
  });

  it('reverses only horizontal movement when the group is right to left', () => {
    expect(readerChoiceIndex('ArrowRight', 1, 3, 'rtl')).toBe(0);
    expect(readerChoiceIndex('ArrowLeft', 1, 3, 'rtl')).toBe(2);
    expect(readerChoiceIndex('ArrowDown', 1, 3, 'rtl')).toBe(2);
    expect(readerChoiceIndex('ArrowUp', 1, 3, 'rtl')).toBe(0);
  });

  it('Home and End choose the first and last enabled option in either direction', () => {
    for (const direction of ['ltr', 'rtl']) {
      expect(readerChoiceIndex('Home', 1, 3, direction)).toBe(0);
      expect(readerChoiceIndex('End', 1, 3, direction)).toBe(2);
    }
  });

  it('leaves unrelated keys and a disabled or absent focused choice alone', () => {
    for (const key of ['Tab', 'Enter', ' ', 'PageDown']) expect(readerChoiceIndex(key, 1, 3)).toBeNull();
    expect(readerChoiceIndex('ArrowRight', -1, 2)).toBeNull();
    expect(readerChoiceIndex('Home', 0, 0)).toBeNull();
    expect(readerChoiceIndex('End', 2, 2)).toBeNull();
  });

  it('keeps one remaining enabled option selected', () => {
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(readerChoiceIndex(key, 0, 1)).toBe(0);
    }
  });
});

// Only the DOM methods consumed by the handler are adapted here. These tests prove its effects;
// browser Tab order, layout, native focus and persistence remain the separate UI spec's job.
function choiceGroup(names = ['Arabic', 'Both', 'English']) {
  const sequence: string[] = [];
  const events: KeyboardEvent<HTMLElement>[] = [];
  const selected = vi.fn((name: string) => sequence.push(`click:${name}`));
  type Radio = {
    disabled: boolean;
    ariaDisabled: string | null;
    owner: unknown;
    closest: (selector: string) => unknown;
    getAttribute: (name: string) => string | null;
    focus: ReturnType<typeof vi.fn>;
    click: ReturnType<typeof vi.fn>;
  };
  let active: Radio;
  const group = { direction: 'ltr', choices: [] as Radio[], querySelectorAll: (): Radio[] => group.choices };
  group.choices = names.map((name) => {
    const radio: Radio = {
      disabled: false, ariaDisabled: null, owner: group,
      closest: (selector) => selector === 'button[role="radio"]' || selector === 'button, a'
        ? radio : selector === '[role="radiogroup"]' ? radio.owner : null,
      getAttribute: (attribute) => attribute === 'aria-disabled' ? radio.ariaDisabled : null,
      focus: vi.fn(() => { active = radio; sequence.push(`focus:${name}`); }),
      click: vi.fn(() => selected(name)),
    };
    return radio;
  });
  active = group.choices[0];
  vi.stubGlobal('getComputedStyle', vi.fn((element: typeof group) => ({ direction: element.direction })));
  const press = (key: string, modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}, target: unknown = active) => {
    const event = { key, altKey: false, ctrlKey: false, metaKey: false, ...modifiers,
      target, currentTarget: group, defaultPrevented: false, preventDefault: vi.fn() };
    const preventDefault = event.preventDefault;
    preventDefault.mockImplementation(() => { event.defaultPrevented = true; });
    events.push(event as unknown as KeyboardEvent<HTMLElement>);
    onReaderChoiceKey(event as unknown as KeyboardEvent<HTMLElement>);
    return preventDefault;
  };
  return { group, selected, sequence, events, press, get active() { return active; } };
}

afterEach(() => vi.unstubAllGlobals());

describe('reader choice keyboard handler effects', () => {
  it('focuses without scrolling before invoking the existing choice callback', () => {
    const fixture = choiceGroup();
    // Key events may originate from a label inside a choice rather than its button.
    const label = { closest: () => fixture.group.choices[0] };
    const preventDefault = fixture.press('ArrowRight', {}, label);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(fixture.active).toBe(fixture.group.choices[1]);
    expect(fixture.group.choices[1].focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(fixture.selected).toHaveBeenCalledExactlyOnceWith('Both');
    expect(fixture.sequence).toEqual(['focus:Both', 'click:Both']);
  });

  it('skips both native and ARIA-disabled choices and choices in a nested group', () => {
    const fixture = choiceGroup(['current', 'disabled', 'aria-disabled', 'nested', 'available']);
    const [, disabled, ariaDisabled, nested, available] = fixture.group.choices;
    disabled.disabled = true;
    ariaDisabled.ariaDisabled = 'true';
    nested.owner = {};
    fixture.press('ArrowRight');
    expect(fixture.active).toBe(available);
    fixture.press('ArrowLeft');
    expect(fixture.active).toBe(fixture.group.choices[0]);
    expect(fixture.selected.mock.calls).toEqual([['available'], ['current']]);
    for (const excluded of [disabled, ariaDisabled, nested]) {
      expect(excluded.focus).not.toHaveBeenCalled();
      expect(excluded.click).not.toHaveBeenCalled();
    }
  });

  it('repeated arrows move from the currently focused choice and wrap once', () => {
    const fixture = choiceGroup();
    fixture.press('ArrowRight');
    fixture.press('ArrowRight');
    fixture.press('ArrowRight');
    expect(fixture.active).toBe(fixture.group.choices[0]);
    expect(fixture.selected.mock.calls).toEqual([['Both'], ['English'], ['Arabic']]);
    for (const choice of fixture.group.choices) {
      expect(choice.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(choice.click).toHaveBeenCalledOnce();
    }
  });

  it('Home and End on the current endpoint do not repeat a selection callback', () => {
    const fixture = choiceGroup();
    expect(fixture.press('Home')).toHaveBeenCalledOnce();
    expect(fixture.selected).not.toHaveBeenCalled();
    expect(fixture.sequence).toEqual([]);
    fixture.press('End');
    fixture.press('End');
    fixture.press('Home');
    fixture.press('Home');
    expect(fixture.selected.mock.calls).toEqual([['English'], ['Arabic']]);
    expect(fixture.sequence).toEqual(['focus:English', 'click:English', 'focus:Arabic', 'click:Arabic']);
  });

  it('ignores modified keys, unrelated keys and non-choice or nested-group targets', () => {
    const fixture = choiceGroup();
    for (const modifier of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(fixture.press('ArrowRight', modifier)).not.toHaveBeenCalled();
    }
    for (const key of ['Tab', 'Enter', ' ', 'PageDown']) expect(fixture.press(key)).not.toHaveBeenCalled();
    expect(fixture.press('ArrowRight', {}, { closest: () => null })).not.toHaveBeenCalled();
    const nested = { closest: (selector: string): unknown => selector === 'button[role="radio"]' ? nested : {} };
    expect(fixture.press('ArrowRight', {}, nested)).not.toHaveBeenCalled();
    expect(fixture.selected).not.toHaveBeenCalled();
    expect(fixture.sequence).toEqual([]);
  });

  it('uses the group direction for horizontal arrows and stays idle with one enabled choice', () => {
    const fixture = choiceGroup();
    fixture.group.direction = 'rtl';
    fixture.press('ArrowRight');
    expect(fixture.active).toBe(fixture.group.choices[2]);
    expect(fixture.selected).toHaveBeenCalledExactlyOnceWith('English');
    fixture.group.choices[0].disabled = true;
    fixture.group.choices[1].disabled = true;
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(fixture.press(key)).toHaveBeenCalledOnce();
    }
    expect(fixture.selected).toHaveBeenCalledOnce();
    expect(fixture.sequence).toEqual(['focus:English', 'click:English']);
  });
});

describe('choice handling and the manual-reading key watcher', () => {
  it('does not start manual reading for keys consumed by the choice handler', () => {
    const fixture = choiceGroup();
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      fixture.press(key);
      expect(readerHandReadingKey(fixture.events.at(-1)!)).toBe(false);
    }
  });

  it('keeps PageDown/PageUp and modified Home/End as browser scrolling from a radio', () => {
    const fixture = choiceGroup();
    for (const key of ['PageDown', 'PageUp']) {
      expect(fixture.press(key)).not.toHaveBeenCalled();
      expect(readerHandReadingKey(fixture.events.at(-1)!)).toBe(true);
    }
    for (const key of ['Home', 'End']) {
      expect(fixture.press(key, { ctrlKey: true })).not.toHaveBeenCalled();
      expect(readerHandReadingKey(fixture.events.at(-1)!)).toBe(true);
    }
    expect(fixture.selected).not.toHaveBeenCalled();
  });

  it('still treats a handled passage arrow as manual reading while inputs and button activation stay separate', () => {
    const passage = { closest: () => null } as unknown as HTMLElement;
    expect(readerHandReadingKey({ key: 'ArrowDown', target: passage, defaultPrevented: true })).toBe(true);
    const input = { closest: (selector: string) => selector.startsWith('input,') ? {} : null } as unknown as HTMLElement;
    expect(readerHandReadingKey({ key: 'PageDown', target: input, defaultPrevented: false })).toBe(false);
    const fixture = choiceGroup();
    fixture.press(' ');
    expect(readerHandReadingKey(fixture.events.at(-1)!)).toBe(false);
  });
});
