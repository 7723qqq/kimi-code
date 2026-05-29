import type { TUI } from '@earendil-works/pi-tui';
import { Container, Spacer, Text } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { BRAILLE_SPINNER_FRAMES } from '#/tui/constant/rendering';
import { FAILURE_MARK, STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

import {
  applySwarmEvent,
  initialSwarmModel,
  type SwarmEvent,
  type SwarmModel,
  type WorkerRow,
} from './swarm-dashboard-model';

const THROTTLE_MS = 200;

export class SwarmDashboardComponent extends Container {
  private model: SwarmModel;
  private readonly headerText: Text;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlush = false;
  private spinnerFrame = 0;

  constructor(
    task: string,
    private readonly colors: ColorPalette,
    private readonly ui: TUI | undefined,
  ) {
    super();
    this.model = initialSwarmModel(task);
    this.addChild(new Spacer(1));
    this.headerText = new Text('', 0, 0);
    this.addChild(this.headerText);
    this.bodyContainer = new Container();
    this.addChild(this.bodyContainer);
    this.flush();
  }

  apply(event: SwarmEvent): void {
    const prevPhase = this.model.phase;
    this.model = applySwarmEvent(this.model, event);
    if (this.model.phase !== prevPhase) {
      this.flush();
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    this.pendingFlush = true;
    if (this.throttleTimer !== null) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.flush();
    }, THROTTLE_MS);
  }

  /**
   * Always renders the current model. A throttled update may be queued for the
   * live UI; render must not show stale rows, so flush any pending state first.
   */
  override render(width: number): string[] {
    if (this.pendingFlush) this.flush();
    return super.render(width);
  }

  private flush(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.pendingFlush = false;
    this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
    this.headerText.setText(this.buildHeader());
    this.bodyContainer.clear();
    for (const w of this.model.workers.values()) {
      this.bodyContainer.addChild(new Text(this.buildWorkerLine(w), 0, 0));
    }
    this.invalidate();
    this.ui?.requestRender();
  }

  private spinner(): string {
    return BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0]!;
  }

  private buildHeader(): string {
    const c = this.colors;
    const m = this.model;
    const title = m.task.length > 56 ? `${m.task.slice(0, 56)}…` : m.task;
    if (m.phase === 'done' || m.phase === 'cancelled') {
      const bullet = chalk.hex(c.success)(STATUS_BULLET);
      const tag = m.phase === 'cancelled' ? ' · cancelled' : '';
      const summary = `${String(m.workers.size)} workers · ${String(m.doneCount)}✓ ${String(m.failedCount)}✗${tag}`;
      return `${bullet}${chalk.hex(c.primary).bold('Swarm')} ${chalk.dim(`· ${title}`)} ${chalk.dim(`· ${summary}`)}`;
    }
    const phases = [
      `Plan ${m.phase === 'planning' ? this.spinner() : '✓'}`,
      `Workers ${String(m.doneCount + m.failedCount)}/${String(m.total)}`,
      `Synthesize ${m.phase === 'synthesizing' ? this.spinner() : m.phase === 'working' || m.phase === 'planning' ? '·' : '✓'}`,
    ].join('   ');
    const bullet = chalk.hex(c.roleAssistant)(STATUS_BULLET);
    return `${bullet}${chalk.hex(c.primary).bold('Swarm')} ${chalk.dim(`· ${title}`)}\n  ${chalk.dim(phases)}`;
  }

  private buildWorkerLine(w: WorkerRow): string {
    const c = this.colors;
    const role = chalk.hex(c.primary)(w.role);
    if (w.status === 'failed') {
      return `  ${chalk.hex(c.error)(FAILURE_MARK)}${role} ${chalk.hex(c.error)(`failed: ${w.error ?? 'error'}`)}`;
    }
    if (w.status === 'done') {
      const tok = w.tokens !== undefined && w.tokens > 0 ? ` · ${formatTokens(w.tokens)}` : '';
      return `  ${chalk.hex(c.success)('✓ ')}${role} ${chalk.dim(`${String(w.toolCount)} calls${tok}`)}`;
    }
    if (w.status === 'retrying') {
      return `  ${chalk.hex(c.roleAssistant)('⟳ ')}${role} ${chalk.dim('retrying…')}`;
    }
    const activity = w.latestActivity ?? 'starting…';
    return `  ${chalk.hex(c.roleAssistant)(this.spinner())} ${role} ${chalk.dim(`now: ${activity}`)}`;
  }

  dispose(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${String(n)} tok`;
}
