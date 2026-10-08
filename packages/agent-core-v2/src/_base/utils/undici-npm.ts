import * as undiciNpm from 'undici/index.js';

const { Agent, EnvHttpProxyAgent, ProxyAgent, buildConnector, fetch, setGlobalDispatcher } =
  undiciNpm;

export { Agent, EnvHttpProxyAgent, ProxyAgent, buildConnector, fetch, setGlobalDispatcher };

export type Agent = InstanceType<typeof Agent>;

export type EnvHttpProxyAgent = InstanceType<typeof EnvHttpProxyAgent>;

export type ProxyAgent = InstanceType<typeof ProxyAgent>;

export type Dispatcher = undiciNpm.Dispatcher;
