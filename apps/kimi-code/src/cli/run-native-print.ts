/**
 * 纯原生 Kimi Code print-mode 运行器。
 *
 * 摆脱对 agent-core-v2 庞大 DI 容器的依赖，直接基于
 * @moonshot-ai/kimi-code-sdk 提供的 Native Harness 驱动 headless 运行。
 */

import {
  createKimiHarnessNative,
  resolveKimiHome,
  type KimiHarnessOptions,
} from '@moonshot-ai/kimi-code-sdk';

import { createCliTelemetryBootstrap } from './telemetry';
import { createKimiCodeHostIdentity } from './version';
import type { CLIOptions } from './options';
import { resolveOutputFormat } from './options';
import {
  PromptJsonWriter,
  PromptTranscriptWriter,
  type PromptOutput,
  type PromptTurnWriter,
  writeExperimentalVersion,
  writeResumeHint,
} from './prompt-render';
import type { PromptRunIO } from './run-prompt';

export async function runNativePrint(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  const stdout: PromptOutput = io.stdout ?? process.stdout;
  const stderr: PromptOutput = io.stderr ?? process.stderr;
  const promptProcess = io.process ?? process;
  const outputFormat = resolveOutputFormat(opts);

  writeExperimentalVersion(version, outputFormat, stdout, stderr);

  const homeDir = resolveKimiHome();
  const identity = createKimiCodeHostIdentity(version);
  const telemetryBootstrap = createCliTelemetryBootstrap();

  const harnessOptions: KimiHarnessOptions = {
    homeDir: telemetryBootstrap.homeDir || homeDir,
    identity,
    skillDirs: opts.skillsDirs,
    sessionStartedProperties: { yolo: opts.yolo, auto: opts.auto, plan: opts.plan, afk: false },
  };

  const harness = createKimiHarnessNative(harnessOptions);

  try {
    let session = opts.session
      ? await harness.resumeSession({ id: opts.session }).catch(() => null)
      : null;

    if (!session) {
      session = await harness.createSession({
        workDir: process.cwd(),
        sessionStartedProperties: { yolo: opts.yolo, auto: false, plan: false, afk: false },
      });
    }

    if (opts.model) {
      await session.setModel(opts.model);
    }

    const writer: PromptTurnWriter =
      outputFormat === 'stream-json'
        ? new PromptJsonWriter(stdout)
        : new PromptTranscriptWriter(stdout, stderr);

    // 订阅事件流
    session.onEvent((event: any) => {
      const type = event.type || event.event;
      if (type === 'assistant.delta' && event.delta) {
        writer.writeAssistantDelta(event.delta);
      } else if (type === 'thinking.delta' && event.delta) {
        writer.writeThinkingDelta(event.delta);
      } else if (type === 'tool.call') {
        writer.writeToolCall(event.id || 'call', event.name || 'tool', event.arguments || {});
      } else if (type === 'tool.result') {
        writer.writeToolResult(event.id || 'call', event.content || '');
      }
    });

    if (opts.prompt) {
      await session.prompt(opts.prompt);
    }

    writer.finish();

    if (outputFormat === 'text' && session.id) {
      writeResumeHint(session.id, outputFormat, stdout, stderr);
    }
  } catch (error) {
    stderr.write(`[Error]: ${error instanceof Error ? error.message : String(error)}\n`);
    promptProcess.exit(1);
  } finally {
    await harness.close().catch(() => {});
  }
}
