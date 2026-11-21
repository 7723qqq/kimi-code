import '../../vite-preset/test/dom.mjs';

import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { App } from 'vue';
import type { ToastTimer } from '../src/components/ui/useToastTimer';

const [{ createApp }, { useToastTimer }] = await Promise.all([
  import('vue'),
  import('../src/components/ui/useToastTimer'),
]);

let app: App | null = null;

function createTimer(duration: number, onExpire: () => void): ToastTimer {
  let timer!: ToastTimer;
  app = createApp({
    setup() {
      timer = useToastTimer({ duration: () => duration, onExpire });
      return () => null;
    },
  });
  app.mount(document.createElement('div'));
  return timer;
}

afterEach(() => {
  app?.unmount();
  app = null;
  jest.useRealTimers();
});

describe('useToastTimer', () => {
  it('expires after the duration', () => {
    jest.useFakeTimers();
    const onExpire = jest.fn();
    createTimer(1000, onExpire);
    jest.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('pauses and resumes with the remaining time', () => {
    jest.useFakeTimers();
    const onExpire = jest.fn();
    const timer = createTimer(1000, onExpire);
    jest.advanceTimersByTime(400);
    timer.pause();
    jest.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
    timer.resume();
    jest.advanceTimersByTime(599);
    expect(onExpire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('never expires when the duration is zero', () => {
    jest.useFakeTimers();
    const onExpire = jest.fn();
    const timer = createTimer(0, onExpire);
    timer.resume();
    jest.advanceTimersByTime(60000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('expires immediately when resumed after the deadline', () => {
    jest.useFakeTimers();
    const onExpire = jest.fn();
    const timer = createTimer(1000, onExpire);
    jest.advanceTimersByTime(400);
    jest.setSystemTime(1500);
    timer.pause();
    timer.resume();
    jest.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('does not expire after dispose', () => {
    jest.useFakeTimers();
    const onExpire = jest.fn();
    const timer = createTimer(1000, onExpire);
    timer.dispose();
    jest.advanceTimersByTime(2000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
