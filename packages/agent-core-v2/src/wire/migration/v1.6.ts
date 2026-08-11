/**
 * Wire protocol 1.6 lets `context.append_loop_event` tool.call records carry
 * an optional `display` field (the structured UI preview restored for
 * resume/replay, keyed by tool call id on the folded assistant message).
 * The field is optional and version 1.5 records simply lack it — the fold
 * degrades to no preview — so the migration is a pass-through.
 */
import type { WireMigration, WireMigrationRecord } from './migration';

export const migrateV1_5ToV1_6: WireMigration = {
  sourceVersion: '1.5',
  targetVersion: '1.6',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};
