export type TelemetryPrimitive = string | number | boolean | null | undefined;

export type TelemetryProperties = Readonly<Record<string, TelemetryPrimitive>>;

export interface SessionTelemetryContext {
  readonly session_id: string;
}

export interface AgentTelemetryContext {
  readonly agent_id: string;
  /**
   * Which review mode the agent was in. `spec` is distinct from `plan`: the two
   * are separate modes with separate write guards, and reporting a spec as a
   * plan made the two indistinguishable downstream.
   */
  readonly mode: 'agent' | 'plan' | 'spec';
  readonly provider_type?: string;
  readonly protocol?: string;
}

export interface TurnTelemetryContext {
  readonly turn_id?: number;
  readonly trace_id?: string;
  readonly thinking_effort?: string;
}

export interface TelemetryContextPatch
  extends
    Partial<SessionTelemetryContext>,
    Partial<AgentTelemetryContext>,
    Partial<TurnTelemetryContext> {
  readonly model?: string;
}
