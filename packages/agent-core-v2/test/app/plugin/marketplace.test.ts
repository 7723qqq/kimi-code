import { describe, expect, it } from 'bun:test';

import {
  parsePluginMarketplace,
  type MarketplaceLocation,
} from '#/app/plugin/marketplace';

const location: MarketplaceLocation = { raw: '/market', kind: 'local', resolved: '/market' };

const parse = (entry: Record<string, unknown>) =>
  parsePluginMarketplace(
    JSON.stringify({ plugins: [{ id: 'sample', source: 'https://example.com/sample.zip', ...entry }] }),
    location,
  ).plugins[0]!;

describe('parsePluginMarketplace classifications', () => {
  it('derives tier and classification from a distribution category', () => {
    expect(parse({ distribution: { category: 'official', defaultInstall: true, weight: 3 } })).toMatchObject({
      classification: 'official',
      tier: 'official',
      distribution: { category: 'official', defaultInstall: true, weight: 3 },
    });
    expect(parse({ distribution: { category: 'third_party' } })).toMatchObject({
      classification: 'third_party',
      tier: 'curated',
    });
  });

  it('derives the classification from a lone tier', () => {
    expect(parse({ tier: 'official' })).toMatchObject({ tier: 'official', classification: 'official' });
    expect(parse({ tier: 'curated' })).toMatchObject({ tier: 'curated', classification: 'third_party' });
  });

  it('rejects a distribution without a known category', () => {
    expect(() => parse({ distribution: { region: 'cn' } })).toThrow(
      'distribution.category',
    );
  });
});

describe('parsePluginMarketplace platforms', () => {
  it('normalizes platform aliases and deduplicates them', () => {
    expect(parse({ platforms: ['macos', 'darwin', 'win32', 'windows', 'linux'] }).platforms).toEqual([
      'darwin',
      'win32',
      'linux',
    ]);
  });

  it('rejects an empty or unknown platform list', () => {
    expect(() => parse({ platforms: [] })).toThrow('platforms');
    expect(() => parse({ platforms: ['solaris'] })).toThrow('platforms');
  });
});

describe('parsePluginMarketplace integrity fields', () => {
  it('keeps a valid sha256 digest and rejects anything else', () => {
    const digest = 'a'.repeat(64);
    expect(parse({ sha256sum: digest }).sha256sum).toBe(digest);
    expect(() => parse({ sha256sum: 'abc' })).toThrow('sha256sum');
  });

  it('passes icon, filename, cli description and billing through', () => {
    expect(
      parse({
        iconUrl: 'https://example.com/icon.png',
        filename: 'sample.zip',
        cliDescription: 'Installs the sample plugin',
        billing: { plan: 'free' },
      }),
    ).toMatchObject({
      iconUrl: 'https://example.com/icon.png',
      filename: 'sample.zip',
      cliDescription: 'Installs the sample plugin',
      billing: { plan: 'free' },
    });
  });
});

describe('parsePluginMarketplace locale', () => {
  it('keeps plain strings and localized text objects', () => {
    expect(
      parse({
        locale: {
          defaultLocale: 'en',
          en: { cliDescription: 'Adds a sample', shortDescription: 'Sample', longDescription: 'A sample plugin' },
          zh: '示例插件',
        },
      }).locale,
    ).toEqual({
      defaultLocale: 'en',
      en: { cliDescription: 'Adds a sample', shortDescription: 'Sample', longDescription: 'A sample plugin' },
      zh: '示例插件',
    });
  });

  it('rejects a locale entry that is neither text nor an object', () => {
    expect(() => parse({ locale: { en: 42 } })).toThrow('locale.en');
  });
});
