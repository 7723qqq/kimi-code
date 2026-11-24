import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  EFFORT_SWITCH_CONFIG_NAME,
  parseEffortSwitchConfig,
  type EffortSwitchConfig,
} from '@moonshot-ai/app-core/lib';
import type { ReadRequestOptions } from '@moonshot-ai/app-core/api';
import { getKimiWebApi } from '../client/deps';
import { clientPinia } from './pinia';

export const useEffortSwitchStore = defineStore('kimi.effortSwitch', () => {
  const config = ref<EffortSwitchConfig | undefined>(undefined);

  async function refresh(options?: ReadRequestOptions): Promise<void> {
    try {
      const raw = await getKimiWebApi().getClientConfig(EFFORT_SWITCH_CONFIG_NAME, options);
      config.value = raw === null ? undefined : parseEffortSwitchConfig(raw);
    } catch {
      config.value = undefined;
    }
  }

  function resetForTest(): void {
    config.value = undefined;
  }

  return { config, refresh, resetForTest };
});

export function effortSwitchStore() {
  return useEffortSwitchStore(clientPinia);
}
