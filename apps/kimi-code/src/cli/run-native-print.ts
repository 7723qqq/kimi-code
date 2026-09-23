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
    // An explicit --session that cannot be resumed is an error, not a reason to
    // run the prompt against a fresh, empty session: the user asked to continue
    // a specific conversation, and answering without its context is a wrong
    // result that looks like a right one. The TUI reports the same failure
    // instead of falling back (kimi-tui.ts resumeSession).
    const session = opts.session
      ? await harness.resumeSession({ id: opts.session })
      : await harness.createSession({
          workDir: process.cwd(),
          sessionStartedProperties: { yolo: opts.yolo, auto: false, plan: false, afk: false },
          // Headless run (upstream bootstrap `nonInteractive`): the engine
          // skips its dangerous-command ask policy — no human to answer.
          nonInteractive: true,
        });

    if (opts.model) {
      await session.setModel(opts.model);
    }

    const writer: PromptTurnWriter =
      outputFormat === 'stream-json'
        ? new PromptJsonWriter(stdout)
        : new PromptTranscriptWriter(stdout, stderr);

    // `session.prompt()` resolves as soon as the turn is enqueued — the native
    // engine settles the turn asynchronously — so print mode waits for the
    // turn's own completion event here. Closing the harness before that tears
    // down the in-flight turn before it ever reaches the model.
    interface TurnEndFrame {
      readonly reason?: string;
      readonly error?: { readonly message?: string } | string;
    }
    let resolveTurnEnd: (event: TurnEndFrame) => void = () => {};
    const turnEnd = new Promise<TurnEndFrame>((resolve) => {
      resolveTurnEnd = resolve;
    });

    // 订阅事件流
    session.onEvent((event: any) => {
      const type = event.type || event.event;
      if (type === 'turn.ended') {
        resolveTurnEnd(event);
      }
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
      // Turn failures surface through `turn.ended`, not the submission promise
      // (v1/v2 semantics): rethrow here so a failed run exits non-zero instead
      // of printing nothing and exiting 0.
      const ended = await turnEnd;
      if (ended?.reason === 'failed') {
        const detail = ended.error;
        const message =
          typeof detail === 'string'
            ? detail
            : (detail?.message ?? JSON.stringify(detail ?? 'turn failed'));
        throw new Error(message);
      }
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
