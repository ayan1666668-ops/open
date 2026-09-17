import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export const OPENCLAW_STATE_LEASE_SCHEMA = ["schema_meta", "state_leases"]
  .map((table) => extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table))
  .join("\n");

export const OPENCLAW_AGENT_DATABASE_LEASE_SCHEMA = [
  OPENCLAW_STATE_LEASE_SCHEMA,
  extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "agent_database_leases"),
].join("\n");
