import { describe, expect, it } from 'vitest';

import { parseConfigString } from '../src/config/index';
import { configToTomlData } from '../src/config/toml';

describe('retired [agent] config section', () => {
  it('is ignored rather than rejected when a config.toml still carries it', () => {
    const config = parseConfigString(
      `
[providers.kimi]
type = "kimi"

[agent]
engine = "rust"
multi_llm = ["kimi"]
native_tools = true
`,
      'probe.toml',
    );

    expect(Object.keys(config.providers)).toEqual(['kimi']);
    expect(Object.prototype.hasOwnProperty.call(config, 'agent')).toBe(false);
  });

  it('is not re-emitted when the config is written back', () => {
    const config = parseConfigString(
      `
[agent]
engine = "rust"
`,
      'probe.toml',
    );

    expect(configToTomlData(config)).not.toHaveProperty('agent');
  });
});
