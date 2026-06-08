// apps/kimi-web/src/components/__tests__/LoginDialog.test.ts
// Tests for the new managed Kimi OAuth single-flow LoginDialog.
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import LoginDialog from '../LoginDialog.vue';

// LoginDialog uses vue-i18n; default locale is English in the test env.
const global = { plugins: [i18n] };

function makeFlow() {
  return {
    flowId: 'flow_test123',
    provider: 'managed:kimi-code',
    verificationUri: 'https://www.kimi.com/code/authorize_device',
    verificationUriComplete: 'https://www.kimi.com/code/authorize_device?user_code=DEMO-CODE',
    userCode: 'DEMO-CODE',
    expiresIn: 1800,
    interval: 2,
    status: 'pending' as const,
    expiresAt: new Date(Date.now() + 1800 * 1000).toISOString(),
  };
}

function makeProps(overrides: Partial<{
  onStartOAuthLogin: () => Promise<ReturnType<typeof makeFlow> | null>;
  onPollOAuthLogin: () => Promise<{ flowId: string; status: 'pending' | 'authenticated' | 'expired' | 'cancelled'; resolvedAt?: string } | null>;
  onCancelOAuthLogin: () => Promise<void>;
}> = {}) {
  return {
    onStartOAuthLogin: vi.fn().mockResolvedValue(makeFlow()),
    onPollOAuthLogin: vi.fn().mockResolvedValue({ flowId: 'flow_test123', status: 'pending' as const }),
    onCancelOAuthLogin: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('LoginDialog', () => {
  it('挂载后立即调用 onStartOAuthLogin', async () => {
    const onStart = vi.fn().mockResolvedValue(makeFlow());
    mount(LoginDialog, { props: makeProps({ onStartOAuthLogin: onStart }), global });
    // Wait for onMounted async
    await new Promise((r) => setTimeout(r, 0));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('startOAuthLogin 成功后显示设备码', async () => {
    const w = mount(LoginDialog, { props: makeProps(), global });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.text()).toContain('DEMO-CODE');
    expect(w.text()).toContain('Waiting for authorization');
    expect(w.text()).toContain('Device code');
  });

  it('显示验证链接', async () => {
    const w = mount(LoginDialog, { props: makeProps(), global });
    await new Promise((r) => setTimeout(r, 0));
    // The link href should contain the verificationUriComplete
    const link = w.find('a.dc-uri-btn');
    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toContain('DEMO-CODE');
  });

  it('点击关闭按钮调用 onCancelOAuthLogin 并发出 close', async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const w = mount(LoginDialog, { props: makeProps({ onCancelOAuthLogin: onCancel }), global });
    await new Promise((r) => setTimeout(r, 0));
    // Step is device-code now, so cancel is called on close
    await w.get('.close-btn').trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    expect(onCancel).toHaveBeenCalled();
    expect(w.emitted('close')).toBeTruthy();
  });

  it('onStartOAuthLogin 返回 null 时显示错误状态', async () => {
    const onStart = vi.fn().mockResolvedValue(null);
    const w = mount(LoginDialog, { props: makeProps({ onStartOAuthLogin: onStart }), global });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.text()).toContain('daemon does not support login yet');
  });

  it('poll 返回 authenticated → 显示成功状态并发出 success', async () => {
    const onPoll = vi.fn().mockResolvedValue({
      flowId: 'flow_test123',
      status: 'authenticated' as const,
      resolvedAt: new Date().toISOString(),
    });
    // Use interval: 0 so the poll timer fires at next event loop turn
    const onStart = vi.fn().mockResolvedValue({ ...makeFlow(), interval: 0 });
    const w = mount(LoginDialog, { props: makeProps({ onStartOAuthLogin: onStart, onPollOAuthLogin: onPoll }), global });
    // Wait for: mount → startFlow (Promise) → pollTimer(0ms) fires → poll resolves → step='success'
    await new Promise((r) => setTimeout(r, 50));
    // Step transitions to 'success' immediately on authenticated result
    expect(w.text()).toContain('Authorized');
    // The 'success' event is emitted after a 1200ms flash; wait for it
    await new Promise((r) => setTimeout(r, 1300));
    expect(w.emitted('success')).toBeTruthy();
  }, 10000);

  it('poll 返回 expired → 显示过期状态', async () => {
    const onPoll = vi.fn().mockResolvedValue({
      flowId: 'flow_test123',
      status: 'expired' as const,
    });
    const onStart = vi.fn().mockResolvedValue({ ...makeFlow(), interval: 0 });
    const w = mount(LoginDialog, { props: makeProps({ onStartOAuthLogin: onStart, onPollOAuthLogin: onPoll }), global });
    // poll fires at 0ms, result is synchronous after promise resolves
    await new Promise((r) => setTimeout(r, 50));
    expect(w.text()).toContain('Authorization code expired');
  });

  it('错误状态下点击重试会重新调用 onStartOAuthLogin', async () => {
    const onStart = vi.fn()
      .mockResolvedValueOnce(null)              // first call → error
      .mockResolvedValue(makeFlow());           // retry → success
    const w = mount(LoginDialog, { props: makeProps({ onStartOAuthLogin: onStart }), global });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.text()).toContain('daemon does not support login yet');
    // Click retry
    const retryBtn = w.findAll('.act-btn.primary').find((b) => b.text().includes('Retry'));
    expect(retryBtn).toBeTruthy();
    await retryBtn!.trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(w.text()).toContain('DEMO-CODE');
  });

  it('标题始终为"登录 Kimi Code"', async () => {
    const w = mount(LoginDialog, { props: makeProps(), global });
    expect(w.text()).toContain('Sign in to Kimi Code');
  });
});
