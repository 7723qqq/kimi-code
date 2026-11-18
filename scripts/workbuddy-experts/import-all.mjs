#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = path.join(ROOT, '.tmp/workbuddy-all-experts');
const OUT = path.join(ROOT, 'workbuddy-agents-all');
const AGENTS_DIR = path.join(OUT, 'agents');
const REPORTS_DIR = path.join(OUT, 'reports');
const BUNDLE_MAP_PATH = 'C:/Users/Administrator/.workbuddy/app/cache/experts/expert-bundle-map.json';

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

const REVIEW_TOOLS = ['NotifyUser', 'Read', 'Glob', 'Grep', 'WebSearch', 'FetchURL', 'TodoList'];
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

const STARTER_SINGLES = [
  'SeniorDeveloper',
  'CodeReviewExpert',
  'SoftwareArchitect',
  'BackendArchitect',
  'FrontendDeveloper',
  'AiEngineer',
  'DeepResearchExpert',
  'ProductManagementExpert',
];
const STARTER_TEAM = 'SoftwareCompany';

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

function tryReadPrompt(meta, member, localPkg) {
  if (localPkg) {
    const wanted = (member
      ? [member.promptFile, `${member.id}.md`]
      : [meta.promptFile, `${meta.agentName}.md`]
    )
      .filter(Boolean)
      .map((item) => path.basename(item));
    const found = localPkg.agents.find((agent) => wanted.includes(agent.basename));
    if (found) return found;
    if (!member && localPkg.agents.length === 1) return localPkg.agents[0];
  }

  const promptFile = member?.promptFile || meta.promptFile;
  const base = promptFile ? path.basename(promptFile) : `${member?.id || meta.agentName}.md`;
  const file = path.join(SOURCE, 'experts', meta.id, 'agents', base);
  if (!fs.existsSync(file)) return null;
  const parsed = splitFrontmatter(fs.readFileSync(file, 'utf8'));
  return { file, basename: base, data: parsed.data, body: parsed.body };
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

function permissionsForClass(cls) {
  if (cls === 'readonly') return { tools: READ_ONLY_TOOLS, suffix: '（只读分析）' };
  if (cls === 'exec') return { tools: EXEC_TOOLS, suffix: '（可写代码）' };
  return { tools: DOC_TOOLS, suffix: '（写文档）' };
}

function classifyText(meta, member) {
  const parts = [
    meta.id,
    meta.profession?.zh,
    meta.profession?.en,
    meta.description?.zh,
    meta.description?.en,
    ...(meta.tags || []).flatMap((tag) => [tag.zh, tag.en]),
  ];
  if (member) parts.push(member.id, member.profession?.zh, member.profession?.en);
  const text = parts.filter(Boolean).join(' ').toLowerCase();
  if (/architect|review|audit|security|auditor|investigator|审查|评审|架构|安全审计|诊断/.test(text)) {
    return 'readonly';
  }
  if (
    /engineer|developer|frontend|backend|full.?stack|devops|program|code|game|unity|godot|小程序|开发|编程|工程|嵌入式|固件|machine learning|ml|ai工程|blender|技术美术/.test(
      text,
    )
  ) {
    return 'exec';
  }
  return 'doc';
}

function permissionsForSingle(meta) {
  const explicit = SINGLE_PERMISSIONS[meta.id];
  if (explicit) return explicit;
  return permissionsForClass(classifyText(meta, null));
}

function permissionsForMember(team, member, name) {
  if (member.role === 'lead') return { tools: LEAD_TOOLS, suffix: '（编排，不直接改代码）' };
  const role = name.replace(`wb-${kebab(team.id)}-`, '');
  if (/architect|reviewer|auditor|security|investigator/.test(role)) {
    return { tools: READ_ONLY_TOOLS, suffix: '（只读分析）' };
  }
  if (/engineer|developer|qa|designer/.test(role)) {
    return { tools: EXEC_TOOLS, suffix: '（可写代码）' };
  }
  if (/product-manager|researcher|writer|doc/.test(role)) {
    return { tools: DOC_TOOLS, suffix: '（写文档）' };
  }
  return permissionsForClass(classifyText(team, member));
}

function preambleFor(kind, meta, teamNames) {
  const lines = [];
  if (kind === 'team-lead') {
    const members = [...(teamNames?.map?.values() || [])].filter((name) => name !== teamNames?.leadName);
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

function buildAgentFile({ meta, prompt, name, description, whenToUse, tools, subagents, kind, teamNames }) {
  const frontmatter = { name, description };
  if (whenToUse) frontmatter.whenToUse = whenToUse;
  if (tools !== undefined) frontmatter.tools = tools;
  if (subagents !== undefined) frontmatter.subagents = subagents;
  const yamlText = yaml.dump(frontmatter, { lineWidth: -1, noRefs: true });
  const body = applyBodyReplacements(prompt.body.trim(), kind, teamNames);
  const preamble = preambleFor(kind, meta, teamNames);
  return `---\n${yamlText}---\n\n${preamble}\n\n${body}\n`;
}

function uniqueName(base, used) {
  let name = base;
  let index = 2;
  while (used.has(name)) name = `${base}-${index++}`;
  used.add(name);
  return name;
}

function catName(categories, id) {
  const category = categories.find((item) => item.id === id);
  const name = category?.name;
  if (typeof name === 'string') return name;
  if (typeof name?.zh === 'string') return name.zh;
  if (typeof name?.en === 'string') return name.en;
  return id;
}

function md(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function truncate(value, n) {
  const text = String(value ?? '');
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

function gatedReason(meta) {
  if (meta.visibility === 'internal_only') return '仅内部可见（internal_only）';
  if (meta.visibility === 'external_only') return '仅外部渠道（external_only）';
  if (meta.isOPC === true) return 'OPC / 开放平台包，需登录态门户下载';
  return '整包未公开，门户下载需登录';
}

function catalogEntry(meta, status, options = {}) {
  return {
    id: meta.id,
    type: meta.expertType,
    categoryId: meta.categoryId || '12-IndustryConsultant',
    nameZh: meta.displayName?.zh || meta.id,
    nameEn: meta.displayName?.en || meta.id,
    professionZh: meta.profession?.zh || '',
    descriptionZh: meta.description?.zh || meta.description?.en || '',
    status,
    source: options.source || 'cos',
    agentNames: options.agentNames || [],
    missingPrompts: options.missingPrompts || [],
    visibility: meta.visibility,
    isOPC: meta.isOPC,
    reason: options.reason || '',
  };
}

function loadLocalPackages() {
  const root = path.join(SOURCE, 'local/installed');
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const manifestPath = path.join(dir, '.codebuddy-plugin/plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    let plugin;
    try {
      plugin = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    let agentFiles = (plugin.agents || [])
      .map((item) => path.join(dir, item))
      .filter((file) => fs.existsSync(file));
    if (agentFiles.length === 0) {
      const agentsDir = path.join(dir, 'agents');
      if (fs.existsSync(agentsDir)) {
        agentFiles = fs
          .readdirSync(agentsDir)
          .filter((file) => file.endsWith('.md'))
          .map((file) => path.join(agentsDir, file));
      }
    }
    const agents = agentFiles.map((file) => {
      const parsed = splitFrontmatter(fs.readFileSync(file, 'utf8'));
      return { file, basename: path.basename(file), data: parsed.data, body: parsed.body };
    });
    if (agents.length === 0) continue;
    const displayName = plugin.displayName || { zh: name, en: name };
    const profession = plugin.profession || { zh: name, en: name };
    const description =
      typeof plugin.description === 'string'
        ? { zh: plugin.description, en: plugin.description }
        : plugin.description || { zh: name, en: name };
    result.push({
      pluginName: plugin.name || name,
      dir,
      plugin,
      agents,
      expertType: plugin.expertType || 'agent',
      agentName: plugin.agentName || agents[0].basename.replace(/\.md$/, ''),
      displayName,
      profession,
      description,
      categoryId: plugin.categoryId || '12-IndustryConsultant',
    });
  }
  return result;
}

function generateSingle(meta, localPkg, used, generated, catalog) {
  const prompt = tryReadPrompt(meta, null, localPkg);
  if (!prompt) {
    catalog.push(catalogEntry(meta, 'gated', { reason: gatedReason(meta) }));
    return;
  }
  const perms = permissionsForSingle(meta);
  const name = uniqueName(`wb-${kebab(meta.id)}`, used);
  const description = `${descriptionFor(meta, null, prompt.data)}${perms.suffix}`;
  const content = buildAgentFile({
    meta,
    prompt,
    name,
    description,
    whenToUse: whenToUseFor(meta, null),
    tools: perms.tools,
    subagents: [],
    kind: 'single',
  });
  const file = path.join(AGENTS_DIR, `${name}.md`);
  fs.writeFileSync(file, content);
  generated.push({
    name,
    type: 'single',
    sourceId: meta.id,
    promptFile: path.basename(prompt.file),
    description,
    tools: perms.tools.length,
    canWrite: perms.tools.includes('Write'),
    subagents: 0,
    source: localPkg ? 'local-installed' : 'cos',
  });
  catalog.push(
    catalogEntry(meta, 'complete', {
      agentNames: [name],
      source: localPkg ? 'local-installed' : 'cos',
    }),
  );
}

function generateTeam(meta, localPkg, used, generated, catalog) {
  const teamNames = buildTeamNames(meta);
  const available = [];
  const missing = [];
  for (const member of meta.members || []) {
    const prompt = tryReadPrompt(meta, member, localPkg);
    if (prompt) available.push({ member, prompt });
    else missing.push(member.id);
  }
  const lead = available.find((item) => item.member.role === 'lead');
  if (!lead) {
    catalog.push(
      catalogEntry(meta, available.length > 0 ? 'partial' : 'gated', {
        reason: '缺少主理人提示词',
        missingPrompts: missing,
      }),
    );
    return;
  }

  const nameMap = new Map();
  for (const item of available) {
    const base =
      teamNames.map.get(item.member.id) || `wb-${teamNames.teamSlug}-${kebab(item.member.id)}`;
    nameMap.set(item.member.id, uniqueName(base, used));
  }
  const memberNames = available
    .filter((item) => item.member.id !== lead.member.id)
    .map((item) => nameMap.get(item.member.id));

  for (const item of available) {
    const isLead = item.member.role === 'lead';
    const perms = permissionsForMember(meta, item.member, nameMap.get(item.member.id));
    const baseDescription = isLead
      ? meta.description?.zh ||
        `${item.member.profession?.zh || item.member.id}（${meta.displayName?.zh || meta.id} 主理人）`
      : descriptionFor(meta, item.member, item.prompt.data);
    const description = `${baseDescription}${perms.suffix}`;
    const content = buildAgentFile({
      meta,
      prompt: item.prompt,
      name: nameMap.get(item.member.id),
      description,
      whenToUse: whenToUseFor(meta, item.member),
      tools: perms.tools,
      subagents: isLead ? memberNames : [],
      kind: isLead ? 'team-lead' : 'team-member',
      teamNames,
    });
    const file = path.join(AGENTS_DIR, `${nameMap.get(item.member.id)}.md`);
    fs.writeFileSync(file, content);
    generated.push({
      name: nameMap.get(item.member.id),
      type: isLead ? 'team-lead' : 'team-member',
      sourceId: meta.id,
      promptFile: path.basename(item.prompt.file),
      description,
      tools: perms.tools.length,
      canWrite: perms.tools.includes('Write'),
      subagents: isLead ? memberNames.length : 0,
      source: localPkg ? 'local-installed' : 'cos',
    });
  }

  catalog.push(
    catalogEntry(meta, missing.length === 0 ? 'complete' : 'partial', {
      agentNames: [...nameMap.values()],
      missingPrompts: missing,
      source: localPkg ? 'local-installed' : 'cos',
    }),
  );
}

function generateLocalOnly(pkg, used, generated, catalog) {
  if (pkg.agents.length === 0) return;
  const meta = {
    id: `local:${pkg.pluginName}`,
    plugin: pkg.pluginName,
    expertType: pkg.expertType,
    agentName: pkg.agentName,
    displayName: pkg.displayName,
    profession: pkg.profession,
    description: pkg.description,
    categoryId: 'local-installed',
    tags: [],
  };
  const prompt = pkg.agents[0];
  const perms = permissionsForSingle(meta);
  const name = uniqueName(`wb-local-${kebab(pkg.pluginName)}`, used);
  const description = `${descriptionFor(meta, null, prompt.data)}${perms.suffix}`;
  const content = buildAgentFile({
    meta,
    prompt,
    name,
    description,
    whenToUse: whenToUseFor(meta, null),
    tools: perms.tools,
    subagents: [],
    kind: 'single',
  });
  const file = path.join(AGENTS_DIR, `${name}.md`);
  fs.writeFileSync(file, content);
  generated.push({
    name,
    type: 'single',
    sourceId: meta.id,
    promptFile: path.basename(prompt.file),
    description,
    tools: perms.tools.length,
    canWrite: perms.tools.includes('Write'),
    subagents: 0,
    source: 'local-installed',
  });
  catalog.push(
    catalogEntry(meta, 'complete', { agentNames: [name], source: 'local-installed' }),
  );
}

function buildIndex(catalog, categories, generated, counts) {
  const lines = [];
  lines.push('# WorkBuddy 专家全量 Agent 目录');
  lines.push('');
  lines.push('由 `scripts/workbuddy-experts/import-all.mjs` 生成，覆盖 WorkBuddy 5.11.3 专家中心的全部清单条目。');
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push('| 指标 | 数量 |');
  lines.push('|---|---:|');
  lines.push(`| 清单专家（含专家团） | ${counts.manifestExperts} |`);
  lines.push(`| 已生成 Agent 的专家 | ${counts.generatedExperts} |`);
  lines.push(`| 生成的 Agent 文件 | ${counts.generatedAgentFiles} |`);
  lines.push(`| 不完整（部分成员缺失） | ${counts.partial} |`);
  lines.push(`| 受限（无公开提示词） | ${counts.gated} |`);
  lines.push(`| 本地额外专家 | ${counts.localOnly} |`);
  lines.push('');
  lines.push('## 分类');
  lines.push('');
  lines.push('| 分类 | 总数 | 已生成 | 部分 | 受限 |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const category of categories) {
    const list = catalog.filter((item) => item.categoryId === category.id);
    lines.push(
      `| ${catName(categories, category.id)} (\`${category.id}\`) | ${list.length} | ${list.filter((item) => item.status === 'complete').length} | ${list.filter((item) => item.status === 'partial').length} | ${list.filter((item) => item.status === 'gated').length} |`,
    );
  }
  const localList = catalog.filter((item) => item.categoryId === 'local-installed');
  if (localList.length > 0) {
    lines.push(
      `| 本地安装 (\`local-installed\`) | ${localList.length} | ${localList.filter((item) => item.status === 'complete').length} | 0 | 0 |`,
    );
  }
  lines.push('');
  lines.push('## 专家明细');
  for (const category of [...categories, { id: 'local-installed', name: { zh: '本地安装', en: 'Local installed' } }]) {
    const list = catalog.filter((item) => item.categoryId === category.id);
    if (list.length === 0) continue;
    lines.push('');
    lines.push(`### ${catName(categories, category.id) === category.id ? category.name.zh : catName(categories, category.id)}（${list.length}）`);
    lines.push('');
    lines.push('| 专家 | ID | 类型 | 状态 | Agent | 简介 |');
    lines.push('|---|---|---|---|---|---|');
    for (const item of list) {
      const agents = item.agentNames.length
        ? item.agentNames.slice(0, 3).map((name) => `[${name}](./agents/${name}.md)`).join('、') +
          (item.agentNames.length > 3 ? ` 等 ${item.agentNames.length} 个` : '')
        : '—';
      const status =
        item.status === 'complete'
          ? '完整'
          : item.status === 'partial'
            ? '部分'
            : '受限';
      lines.push(
        `| ${md(item.nameZh)} | \`${item.id}\` | ${item.type === 'team' ? '专家团' : '单专家'} | ${status} | ${agents} | ${md(truncate(item.descriptionZh, 80))} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 受限专家');
  lines.push('');
  const gated = catalog.filter((item) => item.status === 'gated');
  lines.push(`以下 ${gated.length} 个专家没有公开提示词，只有元数据；应用通过登录态门户下载，匿名请求返回 401。`);
  lines.push('');
  lines.push('| 专家 | ID | 类型 | 可见性 | 原因 |');
  lines.push('|---|---|---|---|---|');
  for (const item of gated) {
    lines.push(
      `| ${md(item.nameZh)} | \`${item.id}\` | ${item.type === 'team' ? '专家团' : '单专家'} | ${item.visibility || '—'} | ${item.reason || '整包未公开'} |`,
    );
  }
  lines.push('');
  lines.push('## 启用方式');
  lines.push('');
  lines.push('这个目录默认不会被 kimi-code 自动扫描。需要全部加载时，在 `config.toml` 顶层加：');
  lines.push('');
  lines.push('```toml');
  lines.push('extra_agent_dirs = ["workbuddy-agents-all/agents"]');
  lines.push('```');
  lines.push('');
  lines.push('也可以只把需要的 `agents/<name>.md` 复制到 `.agents/agents/workbuddy/`。全部加载会引入数百个 Agent，主 Agent 的选择成本会明显上升；日常建议只启用工程向的 13 个。');
  lines.push('');
  lines.push('两级路由：`/skill:workbuddy-expert 代码 SeniorDeveloper`；skill 位于 `.agents/skills/workbuddy-expert/`，按“分类 → 专家 ID”加载对应提示词。');
  lines.push('');
  lines.push('## 说明');
  lines.push('');
  lines.push('- `agents/<name>.md` 是生成的 Kimi Code Agent；`catalog.json` 是机器可读全量目录。');
  lines.push('- 所有 Agent 都显式声明了 `tools` 和 `subagents`；权限按角色分类。');
  lines.push('- 专家团成员会作为独立 Agent 生成，主理人的 `subagents` 只列出实际可用的成员。');
  lines.push('- 受限专家没有生成占位 Agent，避免把空壳加入目录。');
  lines.push('');
  fs.writeFileSync(path.join(OUT, 'INDEX.md'), lines.join('\n'));
}

function writeRouterSkill(catalog, categories) {
  const skillDir = path.join(ROOT, '.agents/skills/workbuddy-expert');
  const refDir = path.join(skillDir, 'references');
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.mkdirSync(refDir, { recursive: true });

  const allCategories = [
    ...categories,
    { id: 'local-installed', name: { zh: '本地安装', en: 'Local installed' } },
  ];
  const categoryRows = allCategories.map((category) => {
    const list = catalog.filter((item) => item.categoryId === category.id);
    const available = list.filter((item) => item.agentNames.length > 0).length;
    const name = category.name?.zh || catName(categories, category.id);
    return `| ${name} | \`${category.id}\` | ${available} / ${list.length} |`;
  });

  const skill = `---
name: workbuddy-expert
description: 按“分类 → 专家 ID”两级选择 WorkBuddy 专家，加载对应 Agent 提示词执行任务。
whenToUse: 当用户要求使用 WorkBuddy 专家，或给出“代码 / SeniorDeveloper”这类分类和专家 ID 时。
arguments:
  - category
  - expert_id
---

# WorkBuddy 专家路由器

你是一个两级路由器：**分类 → 专家 ID**。

调用参数：
- \`category\`：\`$category\`
- \`expert_id\`：\`$expert_id\`

## 解析

1. 如果 \`$expert_id\` 为空：
   - 如果 \`$category\` 也为空，列出下方“分类”表，要求用户先选分类和专家 ID。
   - 如果 \`$category\` 包含 \`:\`、\`/\` 或空格分隔的两个部分，拆成分类和专家 ID 再继续。
   - 如果只给了分类，读取 \`\${KIMI_SKILL_DIR}/references/catalog.md\`，列出该分类下所有专家 ID 和一句话说明；不要猜。
2. 如果 \`$expert_id\` 非空：
   - 在 \`\${KIMI_SKILL_DIR}/references/catalog.md\` 或 \`\${KIMI_SKILL_DIR}/../../../workbuddy-agents-all/catalog.json\` 中按 ID、中文名、Agent 名匹配。
   - 如果匹配到多个，列出候选 ID，让用户确认。
   - 如果唯一匹配，读取 \`\${KIMI_SKILL_DIR}/../../../workbuddy-agents-all/agents/<agentName>.md\`。
3. 如果分类与专家 ID 冲突，以专家 ID 的实际分类为准，并告知用户。
4. 如果匹配到的专家状态是 \`gated\`（Agent 为 \`—\`），说明它需要登录态安装，不能伪造提示词。

## 执行

读取选中的 Agent 文件后，把它的正文当作本次任务的专家系统提示词：
- 保留角色、流程、输出规范、约束。
- 如果 frontmatter 的 \`tools\` 不含 \`Write\`/\`Edit\`，本次任务保持只读；如果只含 \`Write\`/\`Edit\` 而不含 \`Bash\`，不要执行 shell 命令。
- 忽略 WorkBuddy 专有工具（present_files、TeamCreate、SendMessage 等），使用当前环境的等价工具。
- 如果选中的是专家团主理人，按它的 \`subagents\` 列表继续委派；成员未加载时，先读取对应成员 Agent 文件。
- 最终按该专家的风格交付完整结果。

## 分类

| 分类 | categoryId | 可用/总数 |
|---|---|---|
${categoryRows.join('\n')}

## 分类别名

| 简称 | categoryId |
|---|---|
| 代码、开发 | \`02-Engineering\` |
| 产品、设计 | \`01-ProductDesign\` |
| 内容、写作、文案 | \`06-ContentCreative\` |
| 数据、AI | \`04-DataAI\` |
| 营销、增长 | \`05-MarketingGrowth\` |
| 金融、投资 | \`08-FinanceInvestment\` |
| 游戏、空间 | \`03-GameSpatial\` |
| 销售、电商 | \`07-SalesCommerce\` |
| 运营、人力 | \`09-OperationsHR\` |
| 项目、质量 | \`10-ProjectQuality\` |
| 法务、安全 | \`11-SecurityCompliance\` |
| 行业、顾问 | \`12-IndustryConsultant\` |
| 腾讯、腾讯云 | \`13-TencentZone\` |
| 全球、出海 | \`14-GlobalDevelopment\` |
| 开学、教育 | \`15-BackToSchool\` |
| 本地 | \`local-installed\` |
`;

  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill);

  const ref = [];
  ref.push('# WorkBuddy 专家目录');
  ref.push('');
  ref.push('分类 → 专家 ID 的完整索引。');
  ref.push('');
  for (const category of allCategories) {
    const list = catalog.filter((item) => item.categoryId === category.id);
    if (list.length === 0) continue;
    const name = category.name?.zh || catName(categories, category.id);
    ref.push(`## ${name} (\`${category.id}\`)`);
    ref.push('');
    ref.push('| 专家 ID | 名称 | 类型 | 状态 | Agent | 简介 |');
    ref.push('|---|---|---|---|---|---|');
    for (const item of list) {
      const agents = item.agentNames.length
        ? item.agentNames.map((agent) => `\`${agent}\``).join('、')
        : '—';
      const status =
        item.status === 'complete'
          ? '完整'
          : item.status === 'partial'
            ? '部分'
            : '受限';
      ref.push(
        `| \`${item.id}\` | ${md(item.nameZh)} | ${item.type === 'team' ? '专家团' : '单专家'} | ${status} | ${agents} | ${md(truncate(item.descriptionZh, 80))} |`,
      );
    }
    ref.push('');
  }
  fs.writeFileSync(path.join(refDir, 'catalog.md'), ref.join('\n'));
  return skillDir;
}

function main() {
  const manifestPath = path.join(SOURCE, 'manifest/expert_center.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`missing manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const experts = manifest.experts || [];
  const categories = manifest.categories || [];
  const bundleMap = fs.existsSync(BUNDLE_MAP_PATH)
    ? JSON.parse(fs.readFileSync(BUNDLE_MAP_PATH, 'utf8'))
    : {};
  const localPackages = loadLocalPackages();
  const localByPlugin = new Map(localPackages.map((pkg) => [pkg.pluginName, pkg]));

  if (!OUT.endsWith('workbuddy-agents-all')) throw new Error('unexpected output path');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const used = new Set();
  const generated = [];
  const catalog = [];
  const usedLocal = new Set();

  const byId = new Map(experts.map((expert) => [expert.id, expert]));
  const starter = [
    ...STARTER_SINGLES.map((id) => byId.get(id)).filter(Boolean),
    byId.get(STARTER_TEAM),
  ].filter(Boolean);
  const rest = experts.filter(
    (expert) => !STARTER_SINGLES.includes(expert.id) && expert.id !== STARTER_TEAM,
  );
  const ordered = [...starter, ...rest];

  for (const meta of ordered) {
    const localPkg =
      localByPlugin.get(meta.plugin) ||
      localPackages.find((pkg) => bundleMap[meta.id] === pkg.pluginName);
    if (localPkg) usedLocal.add(localPkg.pluginName);
    if (meta.expertType === 'agent') {
      generateSingle(meta, localPkg, used, generated, catalog);
    } else if (meta.expertType === 'team') {
      generateTeam(meta, localPkg, used, generated, catalog);
    }
  }

  for (const pkg of localPackages) {
    if (usedLocal.has(pkg.pluginName)) continue;
    generateLocalOnly(pkg, used, generated, catalog);
  }

  const names = new Set(generated.map((item) => item.name));
  const errors = [];
  const toolReferences = {};
  const templateVariables = {};

  for (const item of generated) {
    const text = fs.readFileSync(path.join(AGENTS_DIR, `${item.name}.md`), 'utf8');
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
    for (const tool of [
      'TeamCreate',
      'TeamDelete',
      'present_files',
      'automation_update',
      'ImageGen',
      'VideoGen',
      'SendMessage',
    ]) {
      const count = bodyText.split(tool).length - 1;
      if (count > 0) toolReferences[tool] = (toolReferences[tool] || 0) + count;
    }
    for (const variable of bodyText.match(/\$\{[^}]+\}/g) || []) {
      templateVariables[variable] = (templateVariables[variable] || 0) + 1;
    }
  }

  const counts = {
    manifestExperts: experts.length,
    generatedExperts: catalog.filter((item) => item.agentNames.length > 0).length,
    generatedAgentFiles: generated.length,
    partial: catalog.filter((item) => item.status === 'partial').length,
    gated: catalog.filter((item) => item.status === 'gated').length,
    localOnly: catalog.filter((item) => item.categoryId === 'local-installed').length,
  };

  const routerSkill = writeRouterSkill(catalog, categories);
  fs.writeFileSync(path.join(OUT, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  fs.writeFileSync(
    path.join(REPORTS_DIR, 'import-report.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: SOURCE,
        output: OUT,
        routerSkill,
        counts,
        permissions: {
          write: generated.filter((item) => item.canWrite).length,
          readOnly: generated.filter((item) => !item.canWrite).length,
        },
        validation: {
          ok: errors.length === 0,
          errors,
          toolReferences,
          templateVariables,
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(REPORTS_DIR, 'missing-prompts.json'),
    `${JSON.stringify(
      catalog
        .filter((item) => item.status === 'partial' || item.status === 'gated')
        .map((item) => ({
          id: item.id,
          status: item.status,
          missingPrompts: item.missingPrompts,
          reason: item.reason,
        })),
      null,
      2,
    )}\n`,
  );
  buildIndex(catalog, categories, generated, counts);
  fs.writeFileSync(
    path.join(OUT, 'README.md'),
    [
      '# WorkBuddy 全量 Agent 包',
      '',
      '由 `scripts/workbuddy-experts/import-all.mjs` 生成。',
      '',
      `- 清单专家：${counts.manifestExperts}`,
      `- 已生成 Agent 的专家：${counts.generatedExperts}`,
      `- 生成的 Agent 文件：${counts.generatedAgentFiles}`,
      `- 受限（无公开提示词）：${counts.gated}`,
      `- 部分（成员缺失）：${counts.partial}`,
      `- 本地额外专家：${counts.localOnly}`,
      '',
      '默认入口：`/skill:workbuddy-expert 代码 SeniorDeveloper`（两级路由，不需要启用全部）。',
      '',
      '启用全部：在 `config.toml` 顶层加入',
      '',
      '```toml',
      'extra_agent_dirs = ["workbuddy-agents-all/agents"]',
      '```',
      '',
      '也可以只复制 `agents/<name>.md` 到 `.agents/agents/workbuddy/`。完整目录与状态见 `INDEX.md`，机器可读目录见 `catalog.json`。',
      '',
    ].join('\n'),
  );

  console.log(
    JSON.stringify(
      {
        output: OUT,
        routerSkill,
        counts,
        validation: { ok: errors.length === 0, errors, toolReferences, templateVariables },
      },
      null,
      2,
    ),
  );
  if (errors.length > 0) process.exitCode = 1;
}

main();
