import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

function canonicalTableSchema(table: string): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(") STRICT;", start);
  if (start < 0 || end < 0) {
    throw new Error(`Canonical maintenance table is unavailable: ${table}`);
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + ") STRICT;".length);
}

export const OPENCLAW_STATE_LEASE_SCHEMA = ["schema_meta", "state_leases"]
  .map(canonicalTableSchema)
  .join("\n");

export const OPENCLAW_AGENT_DATABASE_LEASE_SCHEMA = [
  OPENCLAW_STATE_LEASE_SCHEMA,
  canonicalTableSchema("agent_database_leases"),
].join("\n");
