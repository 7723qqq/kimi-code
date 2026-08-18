#!/usr/bin/env node
/**
 * Compare minimal role framing vs heavy role-play / heavy system prompt on a
 * DeepSeek v4 flash model.
 *
 * Usage:
 *   node scripts/compare-minimal-prompt.mjs
 *   DEEPSEEK_MODEL=deepseek-v4-flash node scripts/compare-minimal-prompt.mjs
 *
 * It reads the `deepseek` provider from ~/.kimi-code/config.toml by default.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const CONFIG_PATH = process.env.KIMI_CODE_HOME
  ? resolve(process.env.KIMI_CODE_HOME, 'config.toml')
  : resolve(homedir(), '.kimi-code', 'config.toml');

function readDeepSeekProvider() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found: ${CONFIG_PATH}`);
  }
  const text = readFileSync(CONFIG_PATH, 'utf8');
  const section = text.match(/^\[providers\.deepseek\]\s*$/m);
  if (!section) {
    throw new Error('No [providers.deepseek] section found in config.toml');
  }
  const after = text.slice(section.index);
  const nextSection = after.search(/^\[/m);
  const block = (nextSection === -1 ? after : after.slice(0, nextSection));

  const apiKey = block.match(/api[Kk]ey\s*=\s*"([^"]+)"/)?.[1] ?? '';
  const baseUrl = block.match(/base[Uu]rl\s*=\s*"([^"]+)"/)?.[1] ?? 'https://api.deepseek.com';
  return { apiKey, baseUrl };
}

const { apiKey, baseUrl } = readDeepSeekProvider();
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';

const PROMPTS = {
  minimal: 'You are a helpful software engineer assistant.',
  heavyRolePlay: [
    'You are an elite senior software architect with 20 years of experience.',
    'You always think like a seasoned engineer. You often use "we" and "I\'m" in your reasoning.',
    'You must act confident, direct, and take ownership of the task.',
  ].join('\n'),
  heavySystem: [
    'You are Kimi Code, an interactive general AI agent running on a user\'s computer.',
    'Your primary goal is to help users with software engineering tasks by taking action.',
    'You must follow all system instructions, tool use rules, safety rules, and project conventions.',
    'You should be cautious, avoid destructive actions, and always confirm before risky operations.',
    'When handling requests, prefer using tools and making actual changes rather than only explaining.',
  ].join('\n'),
};

const TASKS = [
  'Write a Python function to compute Fibonacci numbers with memoization.',
  'Fix the bug in this JavaScript code and return the corrected version:\nfunction sum(a,b){return a+b;}\nconsole.log(sum("1",2));',
  'You are asked to refactor a large function. First explain what you would do, then give a concise plan.',
];

async function callModel(systemPrompt, userMessage) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content ?? '',
    usage: data.usage ?? {},
  };
}

async function main() {
  console.log(`Model: ${model}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log('');

  for (const [promptName, systemPrompt] of Object.entries(PROMPTS)) {
    console.log(`\n========== ${promptName} ==========`);
    console.log(`System prompt:\n${systemPrompt}\n`);

    for (let i = 0; i < TASKS.length; i += 1) {
      const task = TASKS[i];
      console.log(`--- Task ${i + 1} ---`);
      console.log(`User: ${task}`);
      try {
        const result = await callModel(systemPrompt, task);
        console.log(`Output:\n${result.content}`);
        console.log(`Usage: ${JSON.stringify(result.usage)}`);
      } catch (error) {
        console.error(`Error: ${error.message}`);
      }
      console.log('');
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
