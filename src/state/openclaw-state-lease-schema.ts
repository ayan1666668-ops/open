import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export const STATE_LEASE_SCHEMA_SQL = ["schema_meta", "state_leases"]
  .map((table) => extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table))
  .join("\n");

export const AGENT_DATABASE_LEASE_SCHEMA_SQL = [
  STATE_LEASE_SCHEMA_SQL,
  extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "agent_database_leases"),
].join("\n");
