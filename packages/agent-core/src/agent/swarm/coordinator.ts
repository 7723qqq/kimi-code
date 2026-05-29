import { mapWithConcurrency } from './concurrency';
import { parsePlan } from './parse';
import {
  ALLOWED_WORKER_TOOLS,
  DEFAULT_WORKER_TOOLS,
  PLANNER_SYSTEM_PROMPT,
  SYNTHESIZER_SYSTEM_PROMPT,
  renderPlannerPrompt,
  renderPlannerRetryPrompt,
  renderSynthesizerPrompt,
} from './prompts';
import type { SwarmCoordinatorDeps, SwarmPlan, SwarmProgress } from './types';

export class SwarmCoordinator {
  constructor(private readonly deps: SwarmCoordinatorDeps) {}

  private progress(text: string): void {
    this.deps.onProgress?.(text);
  }

  private emit(progress: SwarmProgress): void {
    this.deps.onProgressCustom?.(progress);
  }

  async run(rootTask: string): Promise<string> {
    this.deps.signal.throwIfAborted();
    this.progress('Planning subtasks…');
    const plan = await this.decompose(rootTask);
    this.progress(`Planned ${String(plan.subtasks.length)} subtasks`);
    this.emit({ phase: 'planned', total: plan.subtasks.length });

    await this.runWave(plan);

    this.emit({ phase: 'synthesizing' });
    this.progress('Synthesizing results…');
    const result = await this.deps.spawnSubagent({
      profileName: 'swarm-synthesizer',
      systemPrompt: SYNTHESIZER_SYSTEM_PROMPT,
      tools: [],
      prompt: renderSynthesizerPrompt(plan),
      description: 'Swarm synthesizer',
      signal: this.deps.signal,
    });
    const succeeded = plan.subtasks.filter((s) => s.status === 'done').length;
    const failed = plan.subtasks.filter((s) => s.status === 'failed').length;
    this.emit({ phase: 'done', succeeded, failed });
    return result.result;
  }

  private async decompose(rootTask: string): Promise<SwarmPlan> {
    const first = await this.deps.spawnSubagent({
      profileName: 'swarm-planner',
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      tools: [],
      prompt: renderPlannerPrompt(rootTask),
      description: 'Swarm planner',
      signal: this.deps.signal,
    });
    const plan = parsePlan(rootTask, first.result);
    if (plan !== null) return plan;

    const retry = await this.deps.spawnSubagent({
      profileName: 'swarm-planner',
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      tools: [],
      prompt: renderPlannerRetryPrompt(rootTask, first.result),
      description: 'Swarm planner (retry)',
      signal: this.deps.signal,
    });
    const retried = parsePlan(rootTask, retry.result);
    if (retried !== null) return retried;

    throw new Error('Swarm planner failed to produce a valid plan after one retry');
  }

  private async runWave(plan: SwarmPlan): Promise<void> {
    const limit = this.deps.maxConcurrency ?? 4;
    await mapWithConcurrency(plan.subtasks, limit, async (st) => {
      this.deps.signal.throwIfAborted();
      st.status = 'running';
      this.progress(`▸ ${st.role}: started`);
      try {
        const out = await this.deps.spawnSubagent({
          profileName: `swarm:${st.role}`,
          systemPrompt: st.systemPrompt,
          tools: (st.toolAllowlist ?? DEFAULT_WORKER_TOOLS).filter((t) =>
            ALLOWED_WORKER_TOOLS.includes(t),
          ),
          prompt: st.prompt,
          description: st.role,
          signal: this.deps.signal,
        });
        st.result = out.result;
        st.status = 'done';
        this.progress(`✓ ${st.role}: done`);
      } catch (err) {
        if (this.deps.signal.aborted) throw err;
        st.status = 'failed';
        st.error = err instanceof Error ? err.message : String(err);
        this.progress(`✗ ${st.role}: failed (${st.error})`);
      }
    });
  }
}
