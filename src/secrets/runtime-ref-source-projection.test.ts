import { describe, expect, it } from "vitest";
import type { SecretRef } from "../config/types.secrets.js";
import {
  buildRefSourceByKey,
  lookupResolvedAssignmentValue,
  setSecretAssignmentSource,
  sourceQualifiedStoreKey,
} from "./runtime-assignment-provenance.js";
import type { SecretAssignment } from "./runtime-shared.js";

function ref(id: string): SecretRef {
  return { source: "store", provider: "default", id };
}

function assignment(id: string): SecretAssignment {
  return {
    ref: ref(id),
    path: `auth-profiles.${id}`,
    expected: "string",
    ownerKind: "account",
    ownerId: `account:${id}`,
    requiredForGateway: false,
    disposition: "isolate",
    apply: () => undefined,
  };
}

describe("buildRefSourceByKey (credential-owner projection)", () => {
  it("marks an auth-store assignment as auth-store", () => {
    const assignmentValue = assignment("NVIDIA_API_KEY");
    setSecretAssignmentSource(assignmentValue, "auth-store");
    const byKey = buildRefSourceByKey([assignmentValue]);
    expect(byKey.get("store:default:NVIDIA_API_KEY")).toEqual(new Set(["auth-store"]));
  });

  it("defaults to config when no source is set", () => {
    const assignmentValue = assignment("NVIDIA_API_KEY");
    const byKey = buildRefSourceByKey([assignmentValue]);
    expect(byKey.get("store:default:NVIDIA_API_KEY")).toEqual(new Set(["config"]));
  });

  it("marks a config assignment as config", () => {
    const assignmentValue = assignment("OPENAI_API_KEY");
    setSecretAssignmentSource(assignmentValue, "config");
    const byKey = buildRefSourceByKey([assignmentValue]);
    expect(byKey.get("store:default:OPENAI_API_KEY")).toEqual(new Set(["config"]));
  });

  it("keeps BOTH sources when the same key is collected from config and auth-store (P1-B)", () => {
    const authAssignment = assignment("SHARED_KEY");
    const configAssignment = assignment("SHARED_KEY");
    setSecretAssignmentSource(authAssignment, "auth-store");
    setSecretAssignmentSource(configAssignment, "config");
    const byKey = buildRefSourceByKey([configAssignment, authAssignment]);
    expect(byKey.get("store:default:SHARED_KEY")).toEqual(new Set(["auth-store", "config"]));
  });

  it("keeps BOTH sources regardless of order", () => {
    const authAssignment = assignment("SHARED_KEY");
    const configAssignment = assignment("SHARED_KEY");
    setSecretAssignmentSource(authAssignment, "auth-store");
    setSecretAssignmentSource(configAssignment, "config");
    const byKey = buildRefSourceByKey([authAssignment, configAssignment]);
    expect(byKey.get("store:default:SHARED_KEY")).toEqual(new Set(["auth-store", "config"]));
  });

  it("does not duplicate a single source", () => {
    const a = assignment("KEY");
    const b = assignment("KEY");
    setSecretAssignmentSource(a, "config");
    setSecretAssignmentSource(b, "config");
    const byKey = buildRefSourceByKey([a, b]);
    expect(byKey.get("store:default:KEY")).toEqual(new Set(["config"]));
  });

  it("distinguishes distinct ref keys", () => {
    const authAssignment = assignment("AUTH_KEY");
    const configAssignment = assignment("CONFIG_KEY");
    setSecretAssignmentSource(authAssignment, "auth-store");
    setSecretAssignmentSource(configAssignment, "config");
    const byKey = buildRefSourceByKey([authAssignment, configAssignment]);
    expect(byKey.get("store:default:AUTH_KEY")).toEqual(new Set(["auth-store"]));
    expect(byKey.get("store:default:CONFIG_KEY")).toEqual(new Set(["config"]));
  });
});

describe("sourceQualifiedStoreKey", () => {
  it("qualifies a ref key with the source and a stable separator", () => {
    const qualified = sourceQualifiedStoreKey(ref("SHARED_KEY"), "auth-store");
    expect(qualified).toBe("store:default:SHARED_KEY\u0000source:auth-store");
    const configQualified = sourceQualifiedStoreKey(ref("SHARED_KEY"), "config");
    expect(configQualified).toBe("store:default:SHARED_KEY\u0000source:config");
    expect(qualified).not.toBe(configQualified);
  });
});

describe("lookupResolvedAssignmentValue (source isolation on collision, P1-B)", () => {
  function resolvedWith(entries: Array<[string, unknown]>): Map<string, unknown> {
    return new Map(entries);
  }

  it("returns the auth-store value for an auth-store assignment on collision", () => {
    const assignmentValue = assignment("SHARED_KEY");
    setSecretAssignmentSource(assignmentValue, "auth-store");
    const resolved = resolvedWith([
      [sourceQualifiedStoreKey(ref("SHARED_KEY"), "auth-store"), "owner-shared"],
      [sourceQualifiedStoreKey(ref("SHARED_KEY"), "config"), "temp-shared"],
    ]);
    expect(lookupResolvedAssignmentValue(assignmentValue, resolved)).toBe("owner-shared");
  });

  it("returns the config (run-store) value for a config assignment on collision — never the owner credential", () => {
    const assignmentValue = assignment("SHARED_KEY");
    setSecretAssignmentSource(assignmentValue, "config");
    const resolved = resolvedWith([
      [sourceQualifiedStoreKey(ref("SHARED_KEY"), "auth-store"), "owner-shared"],
      [sourceQualifiedStoreKey(ref("SHARED_KEY"), "config"), "temp-shared"],
    ]);
    expect(lookupResolvedAssignmentValue(assignmentValue, resolved)).toBe("temp-shared");
  });

  it("returns undefined for a config assignment whose source-qualified value is absent (no silent owner read)", () => {
    const assignmentValue = assignment("SHARED_KEY");
    setSecretAssignmentSource(assignmentValue, "config");
    const resolved = resolvedWith([
      [sourceQualifiedStoreKey(ref("SHARED_KEY"), "auth-store"), "owner-shared"],
    ]);
    expect(lookupResolvedAssignmentValue(assignmentValue, resolved)).toBeUndefined();
  });

  it("falls back to the plain ref key for non-store (legacy) resolution", () => {
    const assignmentValue = assignment("ENV_KEY");
    const resolved = resolvedWith([["store:default:ENV_KEY", "legacy-value"]]);
    expect(lookupResolvedAssignmentValue(assignmentValue, resolved)).toBe("legacy-value");
  });

  it("returns the plain ref key value for a config assignment when no composite key exists", () => {
    const assignmentValue = assignment("PLAIN_KEY");
    setSecretAssignmentSource(assignmentValue, "config");
    const resolved = resolvedWith([["store:default:PLAIN_KEY", "plain-value"]]);
    expect(lookupResolvedAssignmentValue(assignmentValue, resolved)).toBe("plain-value");
  });
});
