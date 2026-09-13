import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** The handoff build alone owns this loader beside its staged native package. */
export function loadFreeBsdProcessIdentityNative(): typeof import("koffi") {
  if ((process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath !== undefined) {
    throw new Error("Managed handoff cannot use an external FreeBSD native resource path");
  }
  const entry = fileURLToPath(new URL("./node_modules/koffi/indirect.cjs", import.meta.url));
  return createRequire(import.meta.url)(entry) as typeof import("koffi");
}
