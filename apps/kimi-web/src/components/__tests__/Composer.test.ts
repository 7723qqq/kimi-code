// apps/kimi-web/src/components/__tests__/Composer.test.ts
// Composer has a real textarea and emits submit with { text, attachments }.
import { mount } from '@vue/test-utils';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import Composer from '../Composer.vue';
import i18n from '../../i18n';

// Composer uses vue-i18n; default locale is English in the test env.
const global = { plugins: [i18n] };

// jsdom doesn't implement URL.createObjectURL / revokeObjectURL — stub them.
beforeAll(() => {
  if (!URL.createObjectURL) {
    URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  } else {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
  }
  if (!URL.revokeObjectURL) {
    URL.revokeObjectURL = vi.fn();
  } else {
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  }
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('Composer', () => {
  it('包含 textarea（placeholder=Type a message…）与发送按钮', () => {
    const w = mount(Composer, { global });
    const textarea = w.find('textarea');
    expect(textarea.exists()).toBe(true);
    expect(textarea.attributes('placeholder')).toContain('Type a message');
    expect(w.text()).toContain('Send');
    expect(w.text()).not.toContain('命令');
    expect(w.text()).not.toContain('可粘贴图片');
  });

  it('输入文本后按 Enter 发出 submit 并清空输入框', async () => {
    const w = mount(Composer, { global });
    const textarea = w.find('textarea');
    await textarea.setValue('你好世界');
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false });
    expect(w.emitted('submit')).toBeTruthy();
    // submit now emits { text, attachments }
    const payload = w.emitted('submit')![0]![0] as { text: string; attachments: { fileId: string }[] };
    expect(payload.text).toBe('你好世界');
    expect(payload.attachments).toEqual([]);
    // textarea should be cleared
    expect((textarea.element as HTMLTextAreaElement).value).toBe('');
  });

  it('Shift+Enter 不提交（插入换行）', async () => {
    const w = mount(Composer, { global });
    const textarea = w.find('textarea');
    await textarea.setValue('第一行');
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true });
    expect(w.emitted('submit')).toBeFalsy();
  });

  it('空输入不提交', async () => {
    const w = mount(Composer, { global });
    const textarea = w.find('textarea');
    await textarea.setValue('   ');
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false });
    expect(w.emitted('submit')).toBeFalsy();
  });

  it('传入 uploadImage prop 时显示附件按钮', () => {
    const uploadImage = vi.fn().mockResolvedValue({ fileId: 'f1', name: 'test.png', mediaType: 'image/png' });
    const w = mount(Composer, { props: { uploadImage }, global });
    const btn = w.find('.attach-btn');
    expect(btn.exists()).toBe(true);
  });

  it('不传 uploadImage prop 时不显示附件按钮', () => {
    const w = mount(Composer, { global });
    const btn = w.find('.attach-btn');
    expect(btn.exists()).toBe(false);
  });

  it('提交时 attachments 包含已上传文件的 fileId', async () => {
    // Mock uploadImage that resolves immediately
    const uploadImage = vi.fn().mockResolvedValue({ fileId: 'file_abc', name: 'photo.png', mediaType: 'image/png' });
    const w = mount(Composer, { props: { uploadImage }, global });

    const file = new File(['data'], 'photo.png', { type: 'image/png' });

    const fileInput = w.find('.file-input-hidden');
    expect(fileInput.exists()).toBe(true);

    Object.defineProperty(fileInput.element, 'files', {
      value: [file],
      configurable: true,
    });
    await fileInput.trigger('change');

    // Wait for the upload mock to resolve
    await new Promise((r) => setTimeout(r, 10));
    await w.vm.$nextTick();

    // Now submit with some text
    const textarea = w.find('textarea');
    await textarea.setValue('看看这张图');
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false });

    expect(w.emitted('submit')).toBeTruthy();
    const payload = w.emitted('submit')![0]![0] as { text: string; attachments: { fileId: string }[] };
    expect(payload.text).toBe('看看这张图');
    expect(payload.attachments).toEqual([{ fileId: 'file_abc' }]);
  });

  it('点击 remove 按钮可以移除附件 chip', async () => {
    const uploadImage = vi.fn().mockResolvedValue({ fileId: 'file_xyz', name: 'img.png', mediaType: 'image/png' });
    const w = mount(Composer, { props: { uploadImage }, global });

    const file = new File(['x'], 'img.png', { type: 'image/png' });
    const fileInput = w.find('.file-input-hidden');
    Object.defineProperty(fileInput.element, 'files', { value: [file], configurable: true });
    await fileInput.trigger('change');

    // Wait for state to update (upload resolves but we just need the chip to appear)
    await w.vm.$nextTick();

    // Chip should be visible (appears immediately when file is picked, before upload resolves)
    expect(w.find('.att-chip').exists()).toBe(true);

    // Click remove
    await w.find('.att-rm').trigger('click');

    // Chip should be gone
    expect(w.find('.att-chip').exists()).toBe(false);
  });

  // jsdom does not implement DataTransfer/ClipboardEvent.clipboardData, so we
  // dispatch a plain 'paste' Event and attach a minimal clipboardData stub.
  function dispatchPaste(clipboardData: {
    items: { kind: string; type: string; getAsFile: () => File | null }[];
    files: File[];
  }): void {
    const event = new Event('paste') as Event & { clipboardData: unknown };
    Object.defineProperty(event, 'clipboardData', { value: clipboardData, configurable: true });
    document.dispatchEvent(event);
  }

  it('document 级 paste 事件（含图片）触发 uploadImage', async () => {
    const uploadImage = vi.fn().mockResolvedValue({ fileId: 'paste_file', name: 'pasted.png', mediaType: 'image/png' });
    const w = mount(Composer, { props: { uploadImage }, global });

    const file = new File(['img'], 'pasted.png', { type: 'image/png' });
    dispatchPaste({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      files: [],
    });

    // Give async addFiles a tick to run
    await new Promise((r) => setTimeout(r, 0));
    await w.vm.$nextTick();

    expect(uploadImage).toHaveBeenCalled();
    expect(w.find('.att-chip').exists()).toBe(true);
  });

  it('document 级 paste 事件（图片在 files 中）也触发 uploadImage', async () => {
    const uploadImage = vi.fn().mockResolvedValue({ fileId: 'paste_file2', name: 'shot.png', mediaType: 'image/png' });
    const w = mount(Composer, { props: { uploadImage }, global });

    const file = new File(['img'], 'shot.png', { type: 'image/png' });
    dispatchPaste({ items: [], files: [file] });

    await new Promise((r) => setTimeout(r, 0));
    await w.vm.$nextTick();

    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(w.find('.att-chip').exists()).toBe(true);
  });

  it('同一张图片同时出现在 items 和 files 时只添加一次（去重）', async () => {
    const uploadImage = vi.fn().mockResolvedValue({ fileId: 'paste_dup', name: 'dup.png', mediaType: 'image/png' });
    const w = mount(Composer, { props: { uploadImage }, global });

    const file = new File(['img'], 'dup.png', { type: 'image/png' });
    dispatchPaste({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      files: [file],
    });

    await new Promise((r) => setTimeout(r, 0));
    await w.vm.$nextTick();

    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(w.findAll('.att-chip').length).toBe(1);
  });

  it('document 级 paste 事件（纯文本）不触发 uploadImage', async () => {
    const uploadImage = vi.fn().mockResolvedValue(null);
    const w = mount(Composer, { props: { uploadImage }, global });

    dispatchPaste({ items: [], files: [] });

    await new Promise((r) => setTimeout(r, 0));
    await w.vm.$nextTick();

    expect(uploadImage).not.toHaveBeenCalled();
  });

  // --- Editable message queue --------------------------------------------------

  it('队列条目渲染文字和 remove(×) 按钮', () => {
    const w = mount(Composer, { props: { running: true, queued: ['修复登录', '加测试'] }, global });
    const items = w.findAll('.queue-item');
    expect(items.length).toBe(2);
    expect(items[0]!.find('.queue-text').text()).toBe('修复登录');
    expect(items[0]!.find('.queue-rm').exists()).toBe(true);
  });

  it('点击队列条目把文字载入输入框，并发出 editQueued(index)', async () => {
    const w = mount(Composer, { props: { running: true, queued: ['排队的消息'] }, global });
    await w.get('.queue-item .queue-text').trigger('click');

    // The queued text is loaded into the textarea for editing.
    const textarea = w.find('textarea');
    expect((textarea.element as HTMLTextAreaElement).value).toBe('排队的消息');

    // editQueued is emitted with the index so the parent removes it from the queue.
    expect(w.emitted('editQueued')).toBeTruthy();
    expect(w.emitted('editQueued')![0]).toEqual([0]);
  });

  it('输入框已有内容时，编辑队列条目会把队列文字前置（不丢失正在输入的内容）', async () => {
    const w = mount(Composer, { props: { running: true, queued: ['排队消息'] }, global });
    const textarea = w.find('textarea');
    await textarea.setValue('正在输入');
    await w.get('.queue-item .queue-text').trigger('click');
    expect((textarea.element as HTMLTextAreaElement).value).toBe('排队消息\n正在输入');
  });

  it('点击队列条目的 × 按钮发出 unqueue(index)', async () => {
    const w = mount(Composer, { props: { running: true, queued: ['a', 'b'] }, global });
    await w.findAll('.queue-item')[1]!.find('.queue-rm').trigger('click');
    expect(w.emitted('unqueue')).toBeTruthy();
    expect(w.emitted('unqueue')![0]).toEqual([1]);
  });
});
