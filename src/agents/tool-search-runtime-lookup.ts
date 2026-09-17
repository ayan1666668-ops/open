import { TOOL_EXECUTION_GATED_MESSAGE } from "./tool-policy-shared.js";
import { resolveNativeCoreCatalogEntry, visibleCatalogEntries } from "./tool-search-catalog.js";
import { formatUnknownToolIdError, type ToolLookupErrorOptions } from "./tool-search-recovery.js";
import type { CatalogVisibilityOptions, ToolSearchCatalogSession } from "./tool-search-types.js";
import { ToolInputError } from "./tools/common.js";

/**
 * Resolve a Tool Search target by id or unique name, including native core
 * tools omitted from deferred catalog listings. Gated native names fail closed.
 */
export function findToolSearchCatalogEntry(
  catalog: ToolSearchCatalogSession,
  id: string,
  options?: CatalogVisibilityOptions & ToolLookupErrorOptions,
) {
  const needle = id.trim();
  const entries = visibleCatalogEntries(catalog, options);
  const exactIdEntry = entries.find((candidate) => candidate.id === needle);
  if (exactIdEntry) {
    return exactIdEntry;
  }
  const namedEntries = entries.filter((candidate) => candidate.name === needle);
  if (namedEntries.length > 1) {
    throw new ToolInputError(`Ambiguous tool name: ${needle}; use an exact tool id.`);
  }
  const namedEntry = namedEntries[0];
  if (namedEntry) {
    return namedEntry;
  }
  // Native core tools stay callable by name after structured compaction removes
  // them from catalog listings. Unknown-id suggestions include those native
  // entries so a mistype like file_write can recover to write.
  const nativeEntry = resolveNativeCoreCatalogEntry(catalog, needle);
  if (nativeEntry) {
    return nativeEntry;
  }
  const gatedNative = resolveNativeCoreCatalogEntry(
    { ...catalog, directCoreEntries: catalog.gatedDirectCoreEntries ?? [] },
    needle,
  );
  if (gatedNative) {
    throw new ToolInputError(TOOL_EXECUTION_GATED_MESSAGE);
  }
  throw new ToolInputError(
    formatUnknownToolIdError(needle, [...entries, ...(catalog.directCoreEntries ?? [])], options),
  );
}

/** Resolve a Tool Search target by exact catalog or native-core id only. */
export function findToolSearchCatalogEntryByExactId(
  catalog: ToolSearchCatalogSession,
  id: string,
  errorOptions: ToolLookupErrorOptions = {},
) {
  const needle = id.trim();
  const entry =
    catalog.entries.find((candidate) => candidate.id === needle) ??
    resolveNativeCoreCatalogEntry(catalog, needle, { exactIdOnly: true });
  if (entry) {
    return entry;
  }
  const gatedNative = resolveNativeCoreCatalogEntry(
    { ...catalog, directCoreEntries: catalog.gatedDirectCoreEntries ?? [] },
    needle,
    { exactIdOnly: true },
  );
  if (gatedNative) {
    throw new ToolInputError(TOOL_EXECUTION_GATED_MESSAGE);
  }
  throw new ToolInputError(
    formatUnknownToolIdError(needle, [...catalog.entries, ...(catalog.directCoreEntries ?? [])], {
      ...errorOptions,
      exactIdOnly: true,
    }),
  );
}
