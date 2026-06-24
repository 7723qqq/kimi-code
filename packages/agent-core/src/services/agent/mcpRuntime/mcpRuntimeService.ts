import { registerSingleton, SyncDescriptor, toDisposable } from '../../../di';
import { IMcpRuntimeService, type McpRuntimeServiceOptions } from './mcpRuntime';

export class McpRuntimeService implements IMcpRuntimeService {
  constructor(private readonly options: McpRuntimeServiceOptions = {}) {}

  get oauthService() {
    return this.options.manager?.oauthService;
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    return this.options.manager?.waitForInitialLoad(signal) ?? Promise.resolve();
  }

  list() {
    return this.options.manager?.list() ?? [];
  }

  resolved(name: string) {
    return this.options.manager?.resolved(name);
  }

  getRemoteServerUrl(name: string) {
    return this.options.manager?.getRemoteServerUrl(name);
  }

  async reconnect(name: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.options.manager?.reconnect(name);
    signal?.throwIfAborted();
  }

  onStatusChange(listener: Parameters<IMcpRuntimeService['onStatusChange']>[0]) {
    const unsubscribe = this.options.manager?.onStatusChange(listener);
    return toDisposable(unsubscribe ?? (() => undefined));
  }
}

registerSingleton(IMcpRuntimeService, new SyncDescriptor(McpRuntimeService, [{}], true));
