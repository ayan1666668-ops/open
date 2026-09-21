/** Reads prepared provider hooks without activating plugins during model-reference parsing. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { findProviderRuntimeRegistrationInRegistry } from "../plugins/provider-registry-selection.js";
import type { ProviderNormalizeModelIdContext } from "../plugins/provider-runtime.types.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";

/** Refines an already statically normalized model id through its provider hook. */
export function normalizeProviderModelIdWithRuntime(params: {
  provider: string;
  context: ProviderNormalizeModelIdContext;
}): string | undefined {
  // An exact generation, including an empty one, cannot borrow ambient hooks.
  const registry = getPluginRuntimeGenerationRegistry() ?? getPluginRegistryForContext();
  if (!registry) {
    return undefined;
  }
  const registration = findProviderRuntimeRegistrationInRegistry({
    registry,
    provider: params.provider,
    ownerRefs: [],
  });
  if (
    !registration ||
    !Object.getOwnPropertyDescriptor(registration.provider, "normalizeModelId")?.enumerable
  ) {
    return undefined;
  }
  const normalizeModelId = registration.provider.normalizeModelId;
  if (!normalizeModelId) {
    return undefined;
  }
  // Managed hooks retain their bound receiver. Plain hooks get provider fields
  // on demand, with original getter receivers and invocation-local writes.
  const target = { pluginId: registration.pluginId, normalizeModelId };
  let deleted: Set<string | symbol> | undefined;
  const materialize = (key: string | symbol) => {
    if (Object.hasOwn(target, key) || deleted?.has(key) || !Object.isExtensible(target)) {
      return;
    }
    if (Object.getOwnPropertyDescriptor(registration.provider, key)?.enumerable) {
      Object.defineProperty(target, key, {
        value: Reflect.get(registration.provider, key),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  };
  const ownKeys = () => {
    const providerKeys = Reflect.ownKeys(registration.provider).filter(
      (key) =>
        !deleted?.has(key) &&
        Object.getOwnPropertyDescriptor(registration.provider, key)?.enumerable,
    );
    for (const key of providerKeys) {
      materialize(key);
    }
    return [
      ...providerKeys,
      ...Reflect.ownKeys(target).filter((key) => !providerKeys.includes(key)),
    ];
  };
  const receiver = new Proxy(target, {
    get(target, key, receiver) {
      materialize(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      materialize(key);
      return Reflect.has(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      materialize(key);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    ownKeys,
    deleteProperty(target, key) {
      if (!Reflect.deleteProperty(target, key)) {
        return false;
      }
      (deleted ??= new Set()).add(key);
      return true;
    },
    preventExtensions(target) {
      ownKeys();
      return Reflect.preventExtensions(target);
    },
  });
  return normalizeOptionalString(receiver.normalizeModelId(params.context));
}
