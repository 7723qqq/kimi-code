import { describe, expect, it } from 'vitest';

import {
  normalizeAgentProfile,
  type AgentProfileContext,
  type AgentProfileInput,
  type SystemPromptRenderResult,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  _clearAgentProfileContributionsForTests,
  getAgentProfileContributions,
  registerAgentProfile,
} from '#/app/agentProfileCatalog/contribution';
import {
  DEFAULT_REPLY_STYLE_GUIDE,
  NOTIFY_USER_GUIDANCE,
  renderAgentProfilePrompt,
  profileCanDelegate,
  renderPromptTemplateResult,
  renderSystemPromptResult,
  rootDelegationExtras,
  subagentAllowlistFor,
  systemPromptVars,
  withoutDelegatingTargets,
} from '#/app/agentProfileCatalog/profile-shared';

type AssertFalse<T extends false> = T;

type RenderlessInputIsNotAssignable = AssertFalse<
  [{ name: string }] extends [AgentProfileInput] ? true : false
>;

describe('systemPromptVars', () => {
  it('builds the full variable table from the context', () => {
    const vars = systemPromptVars(
      {
        skills: 'SKILLS',
        agentsMd: 'AGENTS',
        cwd: '/work',
        cwdListing: 'LISTING',
        osKind: 'macOS',
        shellName: 'zsh',
        shellPath: '/bin/zsh',
        additionalDirsInfo: '/extra',
      },
      { skillActive: true },
    );

    expect(vars['role_additional']).toBe('');
    expect(vars['os']).toBe('macOS');
    expect(vars['windows_notes']).toBe('');
    expect(vars['shell']).toBe('zsh (`/bin/zsh`)');
    expect(vars['cwd']).toBe('/work');
    expect(vars['cwd_listing']).toBe('LISTING');
    expect(vars['agents_md']).toBe('AGENTS');
    expect(vars['additional_dirs_info']).toBe('/extra');
    expect(vars['skills']).toBe('SKILLS');
    expect(vars['additional_dirs_section']).toContain('## Additional Directories');
    expect(vars['additional_dirs_section']).toContain('/extra');
    expect(vars['skills_section']).toContain('# Skills');
    expect(vars['skills_section']).toContain('SKILLS');
  });

  it('renders missing context fields as empty strings', () => {
    const vars = systemPromptVars({}, { skillActive: true });

    expect(vars['cwd']).toBe('');
    expect(vars['cwd_listing']).toBe('');
    expect(vars['shell']).toBe('');
    expect(vars['agents_md']).toBe('');
    expect(vars['additional_dirs_info']).toBe('');
    expect(vars['additional_dirs_section']).toBe('');
    expect(vars['skills']).toBe('');
    expect(vars['skills_section']).toBe('');
    expect(vars['windows_notes']).toBe('');
    expect(vars['role_additional']).toBe('');
  });

  it('empties skills and the skills section when the Skill tool is off', () => {
    const vars = systemPromptVars({ skills: 'SKILLS' }, { skillActive: false });

    expect(vars['skills']).toBe('');
    expect(vars['skills_section']).toBe('');
  });

  it('lets a context skillActive override the profile default', () => {
    const vars = systemPromptVars({ skills: 'SKILLS', skillActive: true }, { skillActive: false });

    expect(vars['skills']).toBe('SKILLS');
  });

  it('composes Windows notes only on Windows', () => {
    expect(
      systemPromptVars({ osKind: 'Windows' }, { skillActive: true })['windows_notes'],
    ).toContain('IMPORTANT: You are on Windows');
    expect(systemPromptVars({ osKind: 'macOS' }, { skillActive: true })['windows_notes']).toBe('');
  });

  it('composes the plugin instructions section only when sections exist', () => {
    const vars = systemPromptVars({ pluginSections: 'PLUGIN_A' }, { skillActive: true });

    expect(vars['plugin_sections']).toContain('# Plugin Instructions');
    expect(vars['plugin_sections']).toContain('PLUGIN_A');
    expect(systemPromptVars({}, { skillActive: true })['plugin_sections']).toBe('');
  });

  it('defaults host-identity variables to the CLI text', () => {
    const vars = systemPromptVars({}, { skillActive: true });

    expect(vars['product_name']).toBe('Kimi Code CLI');
    expect(vars['reply_style_guide']).toBe(DEFAULT_REPLY_STYLE_GUIDE);
  });

  it('lets the context override host-identity variables', () => {
    const vars = systemPromptVars(
      { productName: 'Kimi Desktop', replyStyleGuide: 'GUI_STYLE' },
      { skillActive: true },
    );

    expect(vars['product_name']).toBe('Kimi Desktop');
    expect(vars['reply_style_guide']).toBe('GUI_STYLE');
  });
});

describe('renderPromptTemplateResult', () => {
  it('substitutes known variables and keeps unknown placeholders verbatim', () => {
    const out = renderPromptTemplateResult(
      'cwd=${cwd} unknown=${nope} bare=$cwd dollar=$${cwd}',
      { cwd: '/work' },
      { skillActive: true },
    ).text;

    expect(out).toBe('cwd=/work unknown=${nope} bare=$cwd dollar=$/work');
  });

  it('resolves ${base_prompt} lazily and only when the template references it', () => {
    let calls = 0;
    const basePrompt = (): SystemPromptRenderResult => {
      calls += 1;
      return {
        text: 'BASE',
        environment: { cwd: '' },
      };
    };

    expect(
      renderPromptTemplateResult('no base here', {}, { skillActive: true }, basePrompt).text,
    ).toBe('no base here');
    expect(calls).toBe(0);

    expect(
      renderPromptTemplateResult('wrap\n\n${base_prompt}', {}, { skillActive: true }, basePrompt)
        .text,
    ).toBe('wrap\n\nBASE');
    expect(calls).toBe(1);
  });

  it('keeps ${base_prompt} verbatim when no base prompt is provided', () => {
    expect(renderPromptTemplateResult('${base_prompt}', {}, { skillActive: true }).text).toBe(
      '${base_prompt}',
    );
  });

  it('keeps ${now} verbatim as an unknown placeholder', () => {
    const result = renderPromptTemplateResult(
      'date=${now} agents=${agents_md}',
      { cwd: '/work', agentsMd: 'AGENTS' },
      { skillActive: true },
    );

    expect(result.text).toBe('date=${now} agents=AGENTS');
    expect(result.environment).toEqual({ cwd: '/work' });
  });

  it('merges environment metadata from a structured base_prompt render', () => {
    const result = renderPromptTemplateResult(
      'custom\n\n${base_prompt}',
      { cwd: '/work' },
      { skillActive: true },
      () => ({
        text: 'BASE',
        environment: { cwd: '/base' },
      }),
    );

    expect(result.text).toBe('custom\n\nBASE');
    expect(result.environment).toEqual({ cwd: '/work' });
  });
});

describe('renderSystemPromptResult', () => {
  it('places the role text at the role slot and injects context sections', () => {
    const prompt = renderSystemPromptResult(
      'ROLE_TEXT',
      { agentsMd: 'AGENTS', skills: 'SKILLS', cwd: '/work' },
      { skillActive: true },
    ).text;

    expect(prompt).toContain('ROLE_TEXT');
    expect(prompt).toContain('AGENTS');
    expect(prompt).toContain('/work');
    expect(prompt).toContain('# Skills');
    expect(prompt).toContain('SKILLS');
  });

  it('omits the skills section when the profile disables the Skill tool', () => {
    const prompt = renderSystemPromptResult('', { skills: 'SKILLS' }, { skillActive: false }).text;

    expect(prompt).not.toContain('# Skills');
    expect(prompt).not.toContain('SKILLS');
  });

  it('shows Windows notes only on Windows', () => {
    expect(
      renderSystemPromptResult('', { osKind: 'Windows' }, { skillActive: true }).text,
    ).toContain('IMPORTANT: You are on Windows');
    expect(
      renderSystemPromptResult('', { osKind: 'macOS' }, { skillActive: true }).text,
    ).not.toContain('IMPORTANT: You are on Windows');
  });

  it('shows the additional directories section only when directories exist', () => {
    expect(
      renderSystemPromptResult('', { additionalDirsInfo: '/extra' }, { skillActive: true }).text,
    ).toContain('## Additional Directories');
    expect(renderSystemPromptResult('', {}, { skillActive: true }).text).not.toContain(
      '## Additional Directories',
    );
  });

  it('shows the plugin instructions section only when plugin sections exist', () => {
    const prompt = renderSystemPromptResult(
      '',
      { pluginSections: 'PLUGIN_A' },
      { skillActive: true },
    ).text;

    expect(prompt).toContain('# Plugin Instructions');
    expect(prompt).toContain('PLUGIN_A');
    expect(renderSystemPromptResult('', {}, { skillActive: true }).text).not.toContain(
      '# Plugin Instructions',
    );
  });

  it('renders the builtin template with no leftover placeholders', () => {
    const prompt = renderSystemPromptResult(
      'ROLE_TEXT',
      {
        skills: 'SKILLS',
        agentsMd: 'AGENTS',
        cwd: '/work',
        cwdListing: 'LISTING',
        osKind: 'Windows',
        shellName: 'cmd',
        shellPath: 'C:\\cmd.exe',
        additionalDirsInfo: '/extra',
      },
      { skillActive: true },
    ).text;

    expect(prompt).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/);
  });

  it('renders the host identity from the context, defaulting to the CLI text', () => {
    const fallback = renderSystemPromptResult('', {}, { skillActive: true }).text;
    expect(fallback).toContain('Kimi Code CLI');
    expect(fallback).toContain(DEFAULT_REPLY_STYLE_GUIDE);

    const overridden = renderSystemPromptResult(
      '',
      { productName: 'Kimi Desktop', replyStyleGuide: 'GUI_STYLE' },
      { skillActive: true },
    ).text;
    expect(overridden).toContain('Kimi Desktop');
    expect(overridden).toContain('GUI_STYLE');
    expect(overridden).not.toContain('Kimi Code CLI');
  });
});

describe('renderSystemPromptResult family prompt shape', () => {
  const base = { agentsMd: 'AGENTS', skills: 'SKILLS', cwd: '/work', osKind: 'macOS' };

  it('uses the minimal shape for a deepseek model', () => {
    const prompt = renderSystemPromptResult(
      '',
      { ...base, modelName: 'deepseek-v4.1-flash' },
      { skillActive: true },
    ).text;

    expect(prompt).toContain('helpful software engineer assistant');
    expect(prompt).toContain('/work');
    expect(prompt).not.toContain('# Tool use');
    expect(prompt).not.toContain('# Coding');
    expect(prompt).not.toContain('The dedicated tools skip VCS metadata');
  });

  it('drops the injected sections in the minimal shape', () => {
    const prompt = renderSystemPromptResult(
      '',
      { ...base, modelName: 'deepseek-v4.1-flash' },
      { skillActive: true },
    ).text;

    expect(prompt).not.toContain('AGENTS');
    expect(prompt).not.toContain('# Skills');
    expect(prompt).not.toContain('SKILLS');
    expect(prompt).toContain('/work');
  });

  it('matches every shipped deepseek name, current and retired alike', () => {
    const names = [
      'deepseek-v4.1-flash',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v3-2-volc',
      'workbuddy/deepseek-v4.1-flash',
      'DeepSeek-V4.1-Flash',
      'xopdeepseekv4pro',
    ];
    for (const modelName of names) {
      const prompt = renderSystemPromptResult('', { ...base, modelName }, { skillActive: true })
        .text;
      expect(prompt, modelName).toContain('helpful software engineer assistant');
      expect(prompt, modelName).not.toContain('# Tool use');
    }
  });

  it('leaves every other model on the shipped template, byte for byte', () => {
    const withoutModel = renderSystemPromptResult('', base, { skillActive: true }).text;
    for (const modelName of ['gpt-4o', 'claude-3.5-sonnet', 'kimi-k3-1', 'my-deepseek-clone']) {
      const prompt = renderSystemPromptResult('', { ...base, modelName }, { skillActive: true })
        .text;
      expect(prompt, modelName).toBe(withoutModel);
      expect(prompt, modelName).toContain('# Tool use');
    }
  });
});

describe('droppedVars', () => {
  // A context rich enough that every variable a template might reference has a
  // value. The distinction under test is which of them the template used.
  const richContext = {
    modelName: 'gpt-4o',
    productName: 'Kimi',
    cwd: '/work',
    cwdListing: 'a.ts\nb.ts',
    osKind: 'Linux',
    shellName: 'bash',
    shellPath: '/bin/bash',
    agentsMd: '# AGENTS',
    skills: 'SKILLS_BODY',
    pluginSections: 'PLUGIN_BODY',
    modelAdaptation: 'ADAPTATION_BODY',
    replyStyleGuide: 'be brief',
    notifyUserActive: true,
    jsRuntimes: [],
    additionalDirsInfo: '/extra',
  };

  it('reports nothing when the full template carries every supplied variable', () => {
    // Regression: `skills`, `plugin_sections` and `additional_dirs_info` are
    // composed into `*_section` blocks. Comparing raw key names against template
    // placeholders alone reported them as dropped even though the content
    // reached the prompt, which made every applyProfile log false warnings.
    const rendered = renderSystemPromptResult('', richContext, { skillActive: true });

    expect(rendered.droppedVars).toBeUndefined();
  });

  it('still reports a variable the full template genuinely never references', () => {
    const rendered = renderSystemPromptResult(
      '',
      { ...richContext, replyStyleGuide: '' },
      { skillActive: true },
    );

    // With no reply-style value supplied there is nothing to lose, so the
    // warning must stay silent — the check is about supplied values only.
    expect(rendered.droppedVars).toBeUndefined();
  });

  it('reports the sections the minimal shape cannot carry', () => {
    const rendered = renderSystemPromptResult(
      '',
      { ...richContext, modelName: 'deepseek-v4-pro' },
      { skillActive: true },
    );

    // The minimal template keeps only the persona and the working directory, so
    // the loss here is real and must still be reported.
    expect(rendered.droppedVars).toContain('agents_md');
    expect(rendered.droppedVars).toContain('skills_section');
    expect(rendered.droppedVars).toContain('plugin_sections');
    expect(rendered.droppedVars).toContain('notify_user_guidance');
    expect(rendered.droppedVars).toContain('cwd_listing');
    expect(rendered.droppedVars).not.toContain('cwd');
    expect(rendered.droppedVars).not.toContain('product_name');
  });

  it('does not report a raw variable whose composed block is referenced', () => {
    // The composed block carries the raw value, so naming only the block is a
    // delivery, not a loss — for the built-in templates and for a user-supplied
    // SYSTEM.md, which documents the raw names as the supported surface.
    // A custom template naturally drops whatever else it does not name, so the
    // assertion is about these two variables and not about the whole list.
    const rendered = renderPromptTemplateResult(
      'body ${skills_section} ${additional_dirs_section}',
      richContext,
      { skillActive: true },
    );

    expect(rendered.text).toContain('SKILLS_BODY');
    expect(rendered.text).toContain('/extra');
    expect(rendered.droppedVars ?? []).not.toContain('skills');
    expect(rendered.droppedVars ?? []).not.toContain('additional_dirs_info');
  });

  it('reports a raw variable when neither it nor its block is referenced', () => {
    const rendered = renderPromptTemplateResult('body only', richContext, { skillActive: true });

    expect(rendered.droppedVars).toContain('skills');
    expect(rendered.droppedVars).toContain('additional_dirs_info');
  });

  it('passes a user template that names the raw variables verbatim', () => {
    // SYSTEM.md is documented to accept the raw names directly
    // (docs/en/customization/agents.md), so a template using them is correct and
    // must not have them reported as dropped.
    const rendered = renderPromptTemplateResult(
      'at ${cwd}\n\n${agents_md}\n\n${skills}\n\n${plugin_sections}',
      richContext,
      { skillActive: true },
    );

    expect(rendered.text).toContain('SKILLS_BODY');
    expect(rendered.text).toContain('PLUGIN_BODY');
    for (const name of ['cwd', 'agents_md', 'skills', 'plugin_sections']) {
      expect(rendered.droppedVars ?? [], name).not.toContain(name);
    }
  });
});

describe('normalizeAgentProfile', () => {
  it('derives a disclosure-free renderSystemPrompt for text-only input', () => {
    const profile = normalizeAgentProfile({
      name: 'text-only',
      systemPrompt: (context) => `cwd:${context.cwd ?? ''}`,
    });

    expect(profile.renderSystemPrompt({ cwd: '/work' })).toEqual({
      text: 'cwd:/work',
      environment: { cwd: '/work' },
    });
    expect(profile.renderSystemPrompt({})).toEqual({
      text: 'cwd:',
      environment: { cwd: '' },
    });
  });

  it('derives systemPrompt from renderSystemPrompt for structured input', () => {
    const render = (context: AgentProfileContext): SystemPromptRenderResult => ({
      text: `structured:${context.cwd ?? ''}`,
      environment: { cwd: context.cwd ?? '' },
    });
    const profile = normalizeAgentProfile({ name: 'structured', renderSystemPrompt: render });

    expect(profile.systemPrompt({ cwd: '/work' })).toBe('structured:/work');
    expect(profile.systemPrompt({ cwd: '/work' })).toBe(
      profile.renderSystemPrompt({ cwd: '/work' }).text,
    );
    expect(profile.renderSystemPrompt({ cwd: '/work' }).environment).toEqual({ cwd: '/work' });
  });

  it('falls back to systemPrompt when renderSystemPrompt is explicitly undefined', () => {
    const profile = normalizeAgentProfile({
      name: 'legacy-undefined',
      systemPrompt: () => 'text-entry',
      renderSystemPrompt: undefined,
    });

    expect(profile.systemPrompt({})).toBe('text-entry');
    expect(profile.renderSystemPrompt({})).toEqual({
      text: 'text-entry',
      environment: { cwd: '' },
    });
  });

  it('rejects a profile without any render entry', () => {
    const renderless = { name: 'empty' } as unknown as AgentProfileInput;
    expect(() => normalizeAgentProfile(renderless)).toThrow(
      /must define systemPrompt or renderSystemPrompt/,
    );
  });

  it('keeps the input object as receiver for a method-style text-only profile', () => {
    const input = {
      name: 'method-text',
      systemPrompt() {
        return `name:${this.name}`;
      },
    };
    const profile = normalizeAgentProfile(input);

    expect(profile.systemPrompt({})).toBe('name:method-text');
    expect(profile.renderSystemPrompt({}).text).toBe('name:method-text');
  });

  it('keeps the input object as receiver for a method-style structured profile', () => {
    const input = {
      name: 'method-structured',
      renderSystemPrompt(): SystemPromptRenderResult {
        return {
          text: `name:${this.name}`,
          environment: { cwd: '' },
        };
      },
    };
    const profile = normalizeAgentProfile(input);

    expect(profile.renderSystemPrompt({}).text).toBe('name:method-structured');
    expect(profile.systemPrompt({})).toBe('name:method-structured');
  });

  it('prefers the structured entry when both are given and keeps cross-entry this calls working', () => {
    const input = {
      name: 'both',
      systemPrompt(_context: AgentProfileContext) {
        return 'text-entry';
      },
      renderSystemPrompt(context: AgentProfileContext): SystemPromptRenderResult {
        return {
          text: `structured:${this.systemPrompt(context)}`,
          environment: { cwd: context.cwd ?? '' },
        };
      },
    };
    const profile = normalizeAgentProfile(input);

    expect(profile.renderSystemPrompt({})).toEqual({
      text: 'structured:text-entry',
      environment: { cwd: '' },
    });
    expect(profile.systemPrompt({})).toBe('structured:text-entry');
  });

  it('registerAgentProfile rejects a renderless profile without touching the registry', () => {
    _clearAgentProfileContributionsForTests();
    try {
      registerAgentProfile({ name: 'kept', systemPrompt: () => 'text' });
      const renderless = { name: 'empty' } as unknown as AgentProfileInput;
      expect(() => registerAgentProfile(renderless)).toThrow(
        /must define systemPrompt or renderSystemPrompt/,
      );
      expect(getAgentProfileContributions().map((profile) => profile.name)).toEqual(['kept']);
    } finally {
      _clearAgentProfileContributionsForTests();
    }
  });
});

describe('subagentAllowlistFor', () => {
  const catalogWithDefault = (subagents: readonly string[] | undefined) => ({
    getDefault: () => ({ subagents }),
  });

  it('inherits the default profile allowlist when the caller declares none', () => {
    expect(subagentAllowlistFor(catalogWithDefault(['coder']), { profileName: 'custom' })).toEqual([
      'coder',
    ]);
  });

  it('keeps an explicit empty caller allowlist instead of inheriting', () => {
    expect(
      subagentAllowlistFor(catalogWithDefault(['coder']), { profileName: 'custom', subagents: [] }),
    ).toEqual([]);
  });

  it('treats a lone "*" allowlist as unrestricted', () => {
    expect(
      subagentAllowlistFor(catalogWithDefault(['coder']), {
        profileName: 'custom',
        subagents: ['*'],
      }),
    ).toBeUndefined();
  });

  it('unions root delegation extras over the declared allowlist', () => {
    expect(
      subagentAllowlistFor(
        catalogWithDefault(['coder']),
        { profileName: 'agent', subagents: ['coder'] },
        ['reviewer'],
      ),
    ).toEqual(['coder', 'reviewer']);
  });

  it('stays unrestricted for a lone "*" even with root extras', () => {
    expect(
      subagentAllowlistFor(catalogWithDefault(['*']), { profileName: 'agent' }, ['reviewer']),
    ).toBeUndefined();
  });
});

describe('rootDelegationExtras', () => {
  const catalog = {
    inspect: (name: string) =>
      name === 'ghost'
        ? undefined
        : name === 'agent' || name === 'coder'
          ? { sourceId: 'builtin' }
          : name === 'tower-worker'
            ? { sourceId: 'feature:tower' }
            : { sourceId: 'workspace' },
  };
  const profiles = [
    { name: 'agent' },
    { name: 'coder' },
    { name: 'tower-worker' },
    { name: 'reviewer' },
  ];

  it('collects discovered file-sourced profiles except the default itself', () => {
    expect(
      rootDelegationExtras(catalog, { profileName: 'agent', subagents: ['coder'] }, profiles),
    ).toEqual(['reviewer']);
  });

  it('honors an explicit allowlist on a discovered main profile instead of unioning', () => {
    expect(
      rootDelegationExtras(catalog, { profileName: 'reviewer', subagents: ['coder'] }, profiles),
    ).toBeUndefined();
  });

  it('honors an explicit allowlist even after the profile leaves the catalog', () => {
    expect(
      rootDelegationExtras(catalog, { profileName: 'ghost', subagents: ['coder'] }, profiles),
    ).toBeUndefined();
  });

  it('unions for a discovered main profile that declares no allowlist', () => {
    expect(rootDelegationExtras(catalog, { profileName: 'reviewer' }, profiles)).toEqual([
      'reviewer',
    ]);
  });
});

describe('profileCanDelegate', () => {
  it('treats an omitted tools list as delegation-capable', () => {
    expect(profileCanDelegate({})).toBe(true);
  });

  it('treats a tools list without Agent and AgentSwarm as terminal', () => {
    expect(profileCanDelegate({ tools: ['Read', 'Bash'] })).toBe(false);
  });

  it('honors disallowedTools over the tools allowlist', () => {
    expect(profileCanDelegate({ tools: ['Agent'], disallowedTools: ['Agent'] })).toBe(false);
    expect(profileCanDelegate({ tools: ['AgentSwarm'] })).toBe(true);
  });
});

describe('withoutDelegatingTargets', () => {
  it('drops delegation-capable targets and keeps terminal and unknown ones', () => {
    const catalog = {
      get: (name: string) =>
        name === 'coder'
          ? { tools: ['Agent', 'Read'] as readonly string[] }
          : name === 'explore'
            ? { tools: ['Read'] as readonly string[] }
            : undefined,
    };

    expect(withoutDelegatingTargets(catalog, ['coder', 'explore', 'missing'])).toEqual([
      'explore',
      'missing',
    ]);
  });
});

describe('systemPromptVars notify_user_guidance', () => {
  it('injects the NotifyUser guidance only when the context marks the tool active', () => {
    const active = systemPromptVars({ notifyUserActive: true }, { skillActive: false });
    expect(active['notify_user_guidance']).toBe(` ${NOTIFY_USER_GUIDANCE}`);
    expect(NOTIFY_USER_GUIDANCE).toContain('If you are working as a subagent');
    expect(NOTIFY_USER_GUIDANCE).toContain('do not automatically reach your parent agent');

    expect(systemPromptVars({ notifyUserActive: false }, { skillActive: false })['notify_user_guidance']).toBe('');
    expect(systemPromptVars({}, { skillActive: false })['notify_user_guidance']).toBe('');
  });
});

describe('renderAgentProfilePrompt', () => {
  it('adds guidance to custom prompts only when the tool is active', () => {
    const profile = normalizeAgentProfile({ name: 'custom', renderSystemPrompt: () => ({ text: 'Custom instructions.', environment: { cwd: '/work' } }) });
    expect(renderAgentProfilePrompt(profile, {}).text).toBe('Custom instructions.');
    expect(renderAgentProfilePrompt(profile, { notifyUserActive: true }).text).toBe(`Custom instructions.\n\n${NOTIFY_USER_GUIDANCE}`);
  });

  it('keeps the normal system prompt guidance once', () => {
    const profile = normalizeAgentProfile({
      name: 'custom',
      renderSystemPrompt: (context) => renderSystemPromptResult('', context, { skillActive: false }),
    });
    const rendered = renderAgentProfilePrompt(profile, { notifyUserActive: true });
    expect(rendered.text.split(NOTIFY_USER_GUIDANCE)).toHaveLength(2);
  });
});
