import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it } from 'vitest';
import Composer from '../src/components/Composer.vue';

function mountComposer() {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        composer: {
          interrupt: 'Interrupt',
          interruptTitle: 'Interrupt',
          placeholder: 'Message Kimi',
          send: 'Send',
        },
      },
    },
  });

  return mount(Composer, {
    global: {
      plugins: [i18n],
    },
  });
}

function waitForCompositionEndTimer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Composer IME input', () => {
  it('does not submit when Enter confirms active composition', async () => {
    const wrapper = mountComposer();
    const textarea = wrapper.get('textarea');

    await textarea.setValue('ni');
    await textarea.trigger('compositionstart');
    await textarea.trigger('keydown', { key: 'Enter', isComposing: true });

    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('does not submit the Enter that immediately follows compositionend', async () => {
    const wrapper = mountComposer();
    const textarea = wrapper.get('textarea');

    await textarea.setValue('你好');
    await textarea.trigger('compositionstart');
    await textarea.trigger('compositionend');
    await textarea.trigger('keydown', { key: 'Enter', isComposing: false });

    expect(wrapper.emitted('submit')).toBeUndefined();

    await waitForCompositionEndTimer();
    await textarea.trigger('keydown', { key: 'Enter', isComposing: false });

    expect(wrapper.emitted('submit')).toEqual([[{ text: '你好', attachments: [] }]]);
  });
});

describe('Composer history recall', () => {
  it('walks sent messages with ArrowUp/ArrowDown and restores the draft', async () => {
    const wrapper = mountComposer();
    const textarea = wrapper.get('textarea');
    const el = textarea.element as HTMLTextAreaElement;

    await textarea.setValue('first');
    await textarea.trigger('keydown', { key: 'Enter' });
    await textarea.setValue('second');
    await textarea.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('submit')).toHaveLength(2);
    expect(el.value).toBe('');

    // ArrowUp recalls the most recent, then the older one.
    await textarea.trigger('keydown', { key: 'ArrowUp' });
    expect(el.value).toBe('second');
    await textarea.trigger('keydown', { key: 'ArrowUp' });
    expect(el.value).toBe('first');

    // ArrowDown walks forward, then restores the (empty) live draft.
    await textarea.trigger('keydown', { key: 'ArrowDown' });
    expect(el.value).toBe('second');
    await textarea.trigger('keydown', { key: 'ArrowDown' });
    expect(el.value).toBe('');
  });

  it('keeps walking past a multi-line entry (caret lands off the first line)', async () => {
    const wrapper = mountComposer();
    const textarea = wrapper.get('textarea');
    const el = textarea.element as HTMLTextAreaElement;

    // Three sends; the middle one is multi-line. After recalling it the caret
    // sits on its LAST line, so the old "ArrowUp only on the first line" gate
    // trapped it there and you could never reach the oldest entry.
    await textarea.setValue('oldest');
    await textarea.trigger('keydown', { key: 'Enter' });
    await textarea.setValue('multi\nline');
    await textarea.trigger('keydown', { key: 'Enter' });
    await textarea.setValue('newest');
    await textarea.trigger('keydown', { key: 'Enter' });

    await textarea.trigger('keydown', { key: 'ArrowUp' });
    expect(el.value).toBe('newest');
    await textarea.trigger('keydown', { key: 'ArrowUp' });
    expect(el.value).toBe('multi\nline');
    // The fix: still recalls the oldest even though the caret is on the last
    // line of the multi-line entry.
    await textarea.trigger('keydown', { key: 'ArrowUp' });
    expect(el.value).toBe('oldest');
  });
});
