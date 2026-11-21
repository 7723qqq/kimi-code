import { BackendChannel } from '../../../../src/shared/backend-channel';

const channel = new BackendChannel('bun', process.stdin, process.stdout);
channel.handle('start', async (_input, signal) => {
  if (process.argv[2] === 'reject') throw new Error('fixture startup failure');
  if (process.argv[2] === 'cancel')
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('fixture cancelled')), {
        once: true,
      });
      void channel.request('browser.collect-dialogs', { sessionId: 'fixture' }).catch(reject);
    });
  return {
    origin: 'http://127.0.0.1:12345',
    port: 12345,
    browserMcpPort: 12346,
    runtime: { name: 'bun', version: process.versions.bun! },
    telemetry: false,
  };
});
channel.handle('shutdown', () => {
  setTimeout(() => {
    void channel.drain().then(() => process.exit(0));
  }, 0);
  return null;
});
channel.onDisconnect(() => process.exit(0));
