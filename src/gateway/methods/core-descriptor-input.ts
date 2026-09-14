// Pure projection of one core method policy spec onto its dispatch descriptor; the policy table
// and its lookups stay owned by core-descriptors.ts.
import type { CoreGatewayMethodSpec } from "./core-descriptors.js";
import { isCoreGatewayMethodProfileDependent } from "./core-profile-access.js";
import type { GatewayMethodDescriptorInput, GatewayMethodHandler } from "./descriptor.js";

export function toCoreGatewayMethodDescriptorInput(
  spec: CoreGatewayMethodSpec,
  handler: GatewayMethodHandler,
): GatewayMethodDescriptorInput {
  return {
    name: spec.name,
    handler,
    owner: { kind: "core", area: "gateway" },
    scope: spec.scope,
    profileAccess: isCoreGatewayMethodProfileDependent(spec.name) ? "required" : "independent",
    ...(spec.since ? { since: spec.since } : {}),
    ...(spec.advertise === false ? { advertise: false } : {}),
    ...(spec.startup === true ? { startup: "unavailable-until-sidecars" } : {}),
    ...(spec.controlPlaneWrite === true ? { controlPlaneWrite: true } : {}),
    ...(spec.description ? { description: spec.description } : {}),
  };
}
