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
