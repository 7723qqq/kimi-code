/**
 * `replayBuilder` barrel — shared replay read-model types.
 *
 * The replay buffer service was folded into `IAgentRecordService` (the
 * projection side of the record stream). Only the cross-domain types remain
 * here: the replay record shapes produced by `record` and the resume-result
 * shapes consumed by the edge (`rpc` / `core-api`).
 */

export * from './types';
