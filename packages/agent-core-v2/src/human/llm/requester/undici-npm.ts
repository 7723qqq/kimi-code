import * as undiciNpm from 'undici/index.js';

const { Agent, EnvHttpProxyAgent } = undiciNpm;

export { Agent, EnvHttpProxyAgent };

export type Agent = InstanceType<typeof Agent>;

export type EnvHttpProxyAgent = InstanceType<typeof EnvHttpProxyAgent>;

export type Dispatcher = undiciNpm.Dispatcher;
