import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export type DirectoryEntry = {
  name: string;
  isDirectory: boolean;
  /** True only for a regular file; absent means the source did not classify kinds. */
  isFile?: boolean;
};

/** Decode the sandbox directory command's metadata, never file contents. */
export function parseDirectoryEntries(text: string): DirectoryEntry[] {
  const entries: unknown = JSON.parse(text);
  if (!Array.isArray(entries)) {
    throw new Error("Invalid sandbox directory listing.");
  }
  return entries.map((entry: unknown) => {
    const record = asNullableRecord(entry);
    if (!record || typeof record.name !== "string" || typeof record.isDirectory !== "boolean") {
      throw new Error("Invalid sandbox directory entry.");
    }
    // Absent isFile preserves unsupported entry kinds: a listing source may
    // not classify kinds, and consumers decline anything not explicitly a
    // regular file or directory. Defaulting absent kinds to false would
    // present kind-less listings as fully classified. Explicit non-boolean
    // kinds are still invalid.
    if (record.isFile !== undefined && typeof record.isFile !== "boolean") {
      throw new Error("Invalid sandbox directory entry.");
    }
    if (record.isFile === undefined) {
      return { name: record.name, isDirectory: record.isDirectory };
    }
    return { name: record.name, isDirectory: record.isDirectory, isFile: record.isFile };
  });
}
