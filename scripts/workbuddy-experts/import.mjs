#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_SOURCE = path.join(ROOT, '.tmp/workbuddy-all-experts');
const DEFAULT_OUT = path.join(ROOT, '.agents/agents/workbuddy');
const DEFAULT_PRESET = 'engineering-starter';

const PRESETS = {
  'engineering-starter': {
    singles: [
      'SeniorDeveloper',
      'CodeReviewExpert',
      'SoftwareArchitect',
      'BackendArchitect',
      'FrontendDeveloper',
      'AiEngineer',
      'DeepResearchExpert',
      'ProductManagementExpert',
    ],
    teams: ['SoftwareCompany'],
  },
  'engineering-full': {
    singles: [
      'SeniorDeveloper',
      'CodeReviewExpert',
      'SoftwareArchitect',
      'BackendArchitect',
      'FrontendDeveloper',
      'AiEngineer',
      'DeepResearchExpert',
      'ProductManagementExpert',
      'SeniorProjectManager',
      'ModernWebappExpert',
      'DataAnalysisExpert',
    ],
    teams: ['SoftwareCompany', 'SoftwareWorkshop', 'OpenSpecDocTeam'],
  },
};

const EXEC_TOOLS = [
  'NotifyUser',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'ExitSpecMode',
  'Glob',
  'Grep',
  'Read',
  'RepoMap',
  'run_code',
  'lsp',
  'Skill',
  'SnapshotList',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TodoList',
  'WaitFor',
  'WebSearch',
  'FetchURL',
  'Write',
  'mcp__*',
];

const REVIEW_TOOLS = [
  'NotifyUser',
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
  'TodoList',
];

const READ_ONLY_TOOLS = ['NotifyUser', 'Read', 'Glob', 'Grep', 'WebSearch', 'FetchURL', 'TodoList'];

const DOC_TOOLS = [
  'NotifyUser',
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
  'Write',
  'Edit',
  'Skill',
  'TodoList',
];

const LEAD_TOOLS = [
  'NotifyUser',
  'Read',
  'Glob',
  'Grep',
  'TodoList',
  'Agent',
  'AgentSwarm',
  'AskUserQuestion',
  'WebSearch',
  'FetchURL',
];

const SINGLE_PERMISSIONS = {
  SeniorDeveloper: { tools: EXEC_TOOLS, suffix: '（可写代码）' },
  CodeReviewExpert: { tools: REVIEW_TOOLS, suffix: '（只读审查）' },
  SoftwareArchitect: { tools: READ_ONLY_TOOLS, suffix: '（只读分析）' },
  BackendArchitect: { tools: READ_ONLY_TOOLS, suffix: '（只读分析）' },
  FrontendDeveloper: { tools: EXEC_TOOLS, suffix: '（可写代码）' },
  AiEngineer: { tools: EXEC_TOOLS, suffix: '（可写代码）' },
  DeepResearchExpert: { tools: DOC_TOOLS, suffix: '（写报告）' },
  ProductManagementExpert: { tools: DOC_TOOLS, suffix: '（写文档）' },
  SeniorProjectManager: { tools: LEAD_TOOLS, suffix: '（编排）' },
  ModernWebappExpert: { tools: EXEC_TOOLS, suffix: '（可写代码）' },
  DataAnalysisExpert: { tools: DOC_TOOLS, suffix: '（写分析报告）' },
};

function usage() {
  console.log(`Usage: node scripts/workbuddy-experts/import.mjs [options]

Options:
  --preset <name>   Preset to import (default: ${DEFAULT_PRESET})
  --source <dir>    Extracted WorkBuddy directory (default: ${DEFAULT_SOURCE})
  --out <dir>       Output directory (default: ${DEFAULT_OUT})
  --help            Show this help

Presets:
${Object.keys(PRESETS).map((name) => `  ${name}`).join('\n')}
`);
}

function parseArgs(argv) {
  const args = { preset: DEFAULT_PRESET, source: DEFAULT_SOURCE, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--preset') args.preset = argv[++i];
    else if (arg === '--source') args.source = path.resolve(argv[++i]);
    else if (arg === '--out') args.out = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function kebab(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

function splitFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { data: {}, body: text };
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close === -1) return { data: {}, body: text };
  const body = lines.slice(close + 1).join('\n');
  const yamlText = lines.slice(1, close).join('\n').trim();
  if (!yamlText) return { data: {}, body };
  try {
    return { data: yaml.load(yamlText) ?? {}, body };
  } catch {
    return { data: {}, body };
  }
}

function readPrompt(source, meta, member) {
  const promptFile = member?.promptFile || meta.promptFile;
  const base = promptFile ? path.basename(promptFile) : `${member?.id || meta.agentName}.md`;
  const file = path.join(source, 'experts', meta.id, 'agents', base);
  if (!fs.existsSync(file)) throw new Error(`missing prompt file: ${file}`);
  const parsed = splitFrontmatter(fs.readFileSync(file, 'utf8'));
  return { file, data: parsed.data, body: parsed.body };
}

function buildTeamNames(team) {
  const teamSlug = kebab(team.id);
  const members = team.members || [];
  const lead = members.find((member) => member.role === 'lead') || { id: team.agentName };
  const leadId = lead.id || team.agentName;
  const prefixMatch = leadId.match(/^(.*?)(?:-team)?-lead$/);
  const prefix = prefixMatch ? `${prefixMatch[1]}-` : '';
  const map = new Map();
  for (const member of members) {
    if (member.role === 'lead') {
      map.set(member.id, `wb-${teamSlug}-lead`);
      continue;
    }
    const role = prefix && member.id.startsWith(prefix) ? member.id.slice(prefix.length) : member.id;
    map.set(member.id, `wb-${teamSlug}-${kebab(role)}`);
  }
  if (!map.has(leadId)) map.set(leadId, `wb-${teamSlug}-lead`);
  return { teamSlug, map, leadId, leadName: map.get(leadId) };
}

function replaceLegacyNames(text, names) {
  const pairs = [...names.map.entries()].sort((a, b) => b[0].length - a[0].length);
  let result = text;
  for (const [oldName, newName] of pairs) result = result.split(oldName).join(newName);
  return result;
}

function descriptionFor(meta, member, promptData) {
  if (member) return `${member.profession?.zh || member.id} — ${meta.displayName?.zh || meta.id} 成员`;
  return meta.description?.zh || promptData.description || meta.profession?.zh || meta.id;
}

function whenToUseFor(meta, member) {
  if (member) return `${member.profession?.zh || member.id}；${meta.displayName?.zh || meta.id} 专家团成员`;
  const tags = (meta.tags || []).map((tag) => tag.zh).filter(Boolean);
  return tags.length > 0 ? tags.join('、') : meta.profession?.zh || '';
}

function permissionsForSingle(id) {
  return SINGLE_PERMISSIONS[id] || { tools: EXEC_TOOLS, suffix: '' };
}

function permissionsForMember(team, member, name) {
  if (member.role === 'lead') return { tools: LEAD_TOOLS, suffix: '（编排，不直接改代码）' };
  const role = name.replace(`wb-${kebab(team.id)}-`, '');
  if (/product-manager|researcher|writer|doc-generator|pm$/.test(role)) {
    return { tools: DOC_TOOLS, suffix: '（写文档）' };
  }
  if (/architect|reviewer|auditor|security|investigator/.test(role)) {
    return { tools: READ_ONLY_TOOLS, suffix: '（只读分析）' };
  }
  if (/engineer|qa|designer|developer/.test(role)) {
    return { tools: EXEC_TOOLS, suffix: '（可写代码）' };
  }
  return { tools: EXEC_TOOLS, suffix: '' };
}

function preambleFor(kind, meta, teamNames) {
  const lines = [];
  if (kind === 'team-lead') {
    const members = [...teamNames.map.values()].filter((name) => name !== teamNames.leadName);
    lines.push(
      `> **Kimi Code 适配**：本环境没有 \`TeamCreate\`/\`TeamDelete\`。原文中的“建立团队”步骤请忽略；直接使用 \`Agent\` 工具按成员名称派发任务，需要并行时使用 \`AgentSwarm\`。所有跨成员信息由你中转，成员产出由你汇编。成员：${members.map((name) => `\`${name}\``).join('、')}。`,
    );
  } else if (kind === 'team-member') {
    lines.push(
      '> **Kimi Code 适配**：你是专家团成员，作为 subagent 运行。原文中的 `SendMessage`/团队消息步骤不适用；完成自己的专业产出后，把完整结果返回给主理人。你的最后一条消息就是交付。',
    );
  } else {
    lines.push(
      `> **Kimi Code 适配**：本 Agent 由 WorkBuddy 专家「${meta.displayName?.zh || meta.id}」迁移而来。原文中 WorkBuddy 专有工具与流程（\`present_files\`、\`TeamCreate\`、\`TeamDelete\`、\`automation_update\`、\`ImageGen\`、\`VideoGen\` 等）不适用；请使用当前可用工具完成等价操作。作为 subagent 运行时，最后一条消息就是给调用方的完整交付。`,
    );
  }
  if (kind !== 'team-member') {
    lines.push('> 保持原文的专业框架与输出规范；若原文与当前工具能力冲突，以当前环境可执行的方案为准。');
  }
  return lines.join('\n');
}

const COMMON_BODY_REPLACEMENTS = [
  ['present_files', '在最终回复中列出交付文件路径'],
  ['automation_update', '自动化任务工具'],
  ['ImageGen', '图像生成工具'],
  ['VideoGen', '视频生成工具'],
  ['TeamDelete', '结束协作'],
  ['TeamCreate', 'Agent'],
  ['SendMessage', '返回结果'],
];

const TEAM_LEAD_BODY_REPLACEMENTS = [
  [
    '1. **建立团队**：任务开始时由主理人亲自创建本次任务的团队（建议命名 `software-<项目简称>`），明确本次协作的边界与上下文。',
    '1. **建立协作上下文**：任务开始时由主理人明确本次协作的边界与上下文。',
  ],
  ['禁止跳过"建立团队"的正式流程', '禁止跳过"建立协作上下文"的步骤'],
  [
    '**团队创建（TeamCreate）必须且只能由主理人执行，严禁委派任何成员创建团队**',
    '**直接使用 Agent 工具派发成员；不需要创建团队**',
  ],
  ['用户需求 → TeamCreate →', '用户需求 → Agent 派发成员 →'],
  ['用户Bug报告 → TeamCreate →', '用户Bug报告 → Agent 派发成员 →'],
  [
    '**创建团队**（TeamCreate，命名 `software-<项目简称>`）',
    '**建立协作上下文**（直接使用 Agent 派发成员）',
  ],
  [
    '**创建团队**（TeamCreate，命名 `software-bugfix-<问题简称>`）',
    '**建立协作上下文**（直接使用 Agent 派发成员）',
  ],
  ['**建立团队**', '**建立协作上下文**'],
];

const TEAM_MEMBER_BODY_REPLACEMENTS = [
  ['**SendMessage 回传**', '**结果回传**'],
  [
    '通过 SendMessage 从主理人处获取任务说明与上游输入（如前序阶段产出）',
    '从主理人派发的任务说明与上游输入中获取上下文（如前序阶段产出）',
  ],
  [
    '必须通过 **SendMessage** 将结构化产出**完整回传**给主理人',
    '必须在最后一条消息中把结构化产出**完整返回**给主理人',
  ],
  ['通过 SendMessage 向主理人请求', '在结果中向主理人说明还需要哪些输入'],
];

function applyBodyReplacements(text, kind, teamNames) {
  let result = replaceLegacyNames(text, teamNames || { map: new Map() });
  const pairs =
    kind === 'team-lead'
      ? [...TEAM_LEAD_BODY_REPLACEMENTS, ...COMMON_BODY_REPLACEMENTS]
      : kind === 'team-member'
        ? [...TEAM_MEMBER_BODY_REPLACEMENTS, ...COMMON_BODY_REPLACEMENTS]
        : COMMON_BODY_REPLACEMENTS;
  for (const [from, to] of pairs) result = result.split(from).join(to);
  return result;
}

function buildAgentFile({
  meta,
  prompt,
  name,
  description,
  whenToUse,
  tools,
  subagents,
  kind,
  teamNames,
}) {
  const frontmatter = { name, description };
  if (whenToUse) frontmatter.whenToUse = whenToUse;
  if (tools !== undefined) frontmatter.tools = tools;
  if (subagents !== undefined) frontmatter.subagents = subagents;
  const yamlText = yaml.dump(frontmatter, { lineWidth: -1, noRefs: true });
  const body = applyBodyReplacements(prompt.body.trim(), kind, teamNames);
  const preamble = preambleFor(kind, meta, teamNames);
  return `---\n${yamlText}---\n\n${preamble}\n\n${body}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const preset = PRESETS[args.preset];
  if (!preset) throw new Error(`unknown preset: ${args.preset}`);

  const outDir = args.out.replaceAll('\\', '/');
  if (!outDir.endsWith('.agents/agents/workbuddy')) {
    throw new Error('refusing to write outside .agents/agents/workbuddy');
  }

  const manifestPath = path.join(args.source, 'manifest/expert_center.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`missing manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const experts = new Map((manifest.experts || []).map((expert) => [expert.id, expert]));

  fs.mkdirSync(outDir, { recursive: true });

  const generated = [];

  for (const id of preset.singles) {
    const meta = experts.get(id);
    if (!meta) throw new Error(`expert not found: ${id}`);
    const prompt = readPrompt(args.source, meta);
    const name = `wb-${kebab(meta.id)}`;
    const perms = permissionsForSingle(meta.id);
    const description = `${descriptionFor(meta, null, prompt.data)}${perms.suffix}`;
    const whenToUse = whenToUseFor(meta, null);
    const content = buildAgentFile({
      meta,
      prompt,
      name,
      description,
      whenToUse,
      tools: perms.tools,
      subagents: [],
      kind: 'single',
    });
    const file = path.join(outDir, `${name}.md`);
    fs.writeFileSync(file, content);
    generated.push({
      name,
      type: 'single',
      sourceId: meta.id,
      promptFile: path.basename(prompt.file),
      file,
      description,
      tools: perms.tools.length,
      canWrite: perms.tools.includes('Write'),
      subagents: 0,
    });
  }

  for (const id of preset.teams) {
    const meta = experts.get(id);
    if (!meta) throw new Error(`expert not found: ${id}`);
    const teamNames = buildTeamNames(meta);
    for (const member of meta.members || []) {
      const name = teamNames.map.get(member.id);
      if (!name) throw new Error(`missing team member name: ${member.id}`);
      const prompt = readPrompt(args.source, meta, member);
      const isLead = member.role === 'lead';
      const perms = permissionsForMember(meta, member, name);
      const baseDescription = isLead
        ? meta.description?.zh || `${member.profession?.zh || member.id}（${meta.displayName?.zh || meta.id} 主理人）`
        : descriptionFor(meta, member, prompt.data);
      const description = `${baseDescription}${perms.suffix}`;
      const whenToUse = whenToUseFor(meta, member);
      const subagents = isLead
        ? [...teamNames.map.entries()].filter(([oldId]) => oldId !== member.id).map(([, newName]) => newName)
        : [];
      const content = buildAgentFile({
        meta,
        prompt,
        name,
        description,
        whenToUse,
        tools: perms.tools,
        subagents,
        kind: isLead ? 'team-lead' : 'team-member',
        teamNames,
      });
      const file = path.join(outDir, `${name}.md`);
      fs.writeFileSync(file, content);
      generated.push({
        name,
        type: isLead ? 'team-lead' : 'team-member',
        sourceId: meta.id,
        promptFile: path.basename(prompt.file),
        file,
        description,
        tools: perms.tools.length,
        canWrite: perms.tools.includes('Write'),
        subagents: subagents.length,
      });
    }
  }

  const names = new Set(generated.map((item) => item.name));
  const errors = [];
  const toolReferences = {};
  const templateVariables = {};

  for (const item of generated) {
    const text = fs.readFileSync(item.file, 'utf8');
    const parsed = splitFrontmatter(text);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.data.name || '')) {
      errors.push(`${item.name}: invalid name`);
    }
    if (!parsed.data.description) errors.push(`${item.name}: missing description`);
    if (!parsed.body.trim()) errors.push(`${item.name}: missing prompt body`);
    if (!Array.isArray(parsed.data.tools) || parsed.data.tools.length === 0) {
      errors.push(`${item.name}: missing tools`);
    }
    if (item.canWrite && !(parsed.data.tools || []).includes('Write')) {
      errors.push(`${item.name}: expected write access`);
    }
    if (!item.canWrite && (parsed.data.tools || []).includes('Write')) {
      errors.push(`${item.name}: unexpected write access`);
    }
    for (const subagent of parsed.data.subagents || []) {
      if (!names.has(subagent)) errors.push(`${item.name}: unknown subagent ${subagent}`);
    }
    const bodyText = parsed.body
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('> **Kimi Code 适配**') && !line.startsWith('> 保持原文'))
      .join('\n');
    for (const tool of ['TeamCreate', 'TeamDelete', 'present_files', 'automation_update', 'ImageGen', 'VideoGen', 'SendMessage']) {
      const count = bodyText.split(tool).length - 1;
      if (count > 0) {
        toolReferences[tool] = (toolReferences[tool] || 0) + count;
      }
    }
    const variables = bodyText.match(/\$\{[^}]+\}/g) || [];
    for (const variable of variables) {
      templateVariables[variable] = (templateVariables[variable] || 0) + 1;
    }
  }

  const duplicateNames = generated.map((item) => item.name).filter((name, index, list) => list.indexOf(name) !== index);
  if (duplicateNames.length > 0) errors.push(`duplicate names: ${[...new Set(duplicateNames)].join(', ')}`);

  const report = {
    generatedAt: new Date().toISOString(),
    preset: args.preset,
    source: args.source,
    output: outDir,
    counts: {
      total: generated.length,
      singles: generated.filter((item) => item.type === 'single').length,
      teamLeads: generated.filter((item) => item.type === 'team-lead').length,
      teamMembers: generated.filter((item) => item.type === 'team-member').length,
    },
    agents: generated.map(({ file: _file, ...rest }) => rest),
    validation: {
      ok: errors.length === 0,
      errors,
      toolReferences,
      templateVariables,
    },
  };

  const reportPath = path.join(ROOT, 'scripts/workbuddy-experts/import-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({ output: outDir, counts: report.counts, validation: report.validation }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

main();
