import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import type { GatewayClient } from "./server-methods/client-types.js";

/** Presentation destination captured from the requesting Control UI, never model arguments. */
export type GatewayUiCommandTarget = Readonly<{
  connId: string;
  profileId?: string;
}>;

export function captureGatewayUiCommandTarget(
  client: GatewayClient | null | undefined,
): GatewayUiCommandTarget | undefined {
  const connId = client?.connId?.trim();
  if (
    !connId ||
    client?.connect.client.id !== GATEWAY_CLIENT_IDS.CONTROL_UI ||
    client.internal?.syntheticClient ||
    client.invalidated ||
    client.connectionSignal?.aborted
  ) {
    return undefined;
  }
  return Object.freeze({
    connId,
    ...(client.authenticatedUserProfile?.profileId
      ? { profileId: client.authenticatedUserProfile.profileId }
      : {}),
  });
}
