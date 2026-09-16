import { Type } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import type {
  McpToolCatalog,
  RequesterMcpConnect,
  RequesterMcpConnectDelivery,
  SessionMcpRequesterScope,
} from "./agent-bundle-mcp-types.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";
import type { AgentToolResult } from "./runtime/index.js";

async function connectRequesterOAuthServer(params: {
  serverName: string;
  publicOrigin?: string;
  delivery?: RequesterMcpConnectDelivery;
  signal?: AbortSignal;
  authorize: (
    redirectUrl: string,
  ) => ReturnType<(typeof import("./mcp-oauth.js"))["startMcpOAuthAuthorization"]>;
}): Promise<AgentToolResult<unknown>> {
  const failure = (message: string): AgentToolResult<unknown> => ({
    content: [{ type: "text", text: message }],
    details: { status: "error", error: message, mcpServer: params.serverName },
  });
  if (!params.publicOrigin) {
    const message =
      `MCP server "${params.serverName}" needs requester sign-in, but gateway.publicOrigin is not configured. ` +
      "Ask the operator to set the public Gateway HTTP(S) origin.";
    return failure(message);
  }
  const delivery = params.delivery;
  if (!delivery) {
    return failure(
      `MCP server "${params.serverName}" needs a private sign-in link, but private delivery is unavailable for this request. ` +
        "Ask the operator to enable a supported private messaging route for your account, then try connecting again.",
    );
  }
  const assertActive = () => {
    params.signal?.throwIfAborted();
    delivery.assertActive();
  };
  assertActive();
  let result: Awaited<ReturnType<typeof params.authorize>>;
  try {
    result = await params.authorize(new URL("/oauth/mcp/callback", params.publicOrigin).href);
  } catch {
    assertActive();
    // Provider errors can include the bearer authorization URL. Never put them
    // into a shared tool result, transcript, or public reply.
    return failure(
      `Could not prepare sign-in for MCP server "${params.serverName}". Try connecting again or ask the operator to check the server's OAuth configuration.`,
    );
  }
  assertActive();
  if (result.status === "authorized") {
    return {
      content: [
        {
          type: "text",
          text: `MCP server "${params.serverName}" is connected. Its tools become available on the next message.`,
        },
      ],
      details: { mcpServer: params.serverName },
    };
  }
  let sent: Awaited<ReturnType<RequesterMcpConnectDelivery["send"]>>;
  try {
    sent = await delivery.send({
      serverName: params.serverName,
      authorizationUrl: result.authorizationUrl,
      assertActive,
    });
  } catch {
    assertActive();
    sent = { status: "failed" };
  }
  assertActive();
  if (sent.status === "unsupported") {
    // Preserve the released in-chat flow only for a channel lacking this capability,
    // never after a private send failed or its originating authority closed.
    return {
      content: [
        {
          type: "text",
          text:
            `Connect MCP server "${params.serverName}" at ${result.authorizationUrl}\n` +
            "This channel's plugin does not support private sign-in delivery. Anyone who can see this link can complete sign-in and connect their account to your pending connection. Use only in a trusted conversation.\n" +
            "After sign-in completes, the server's tools become available on the next message.",
        },
      ],
      details: {
        mcpConnect: { serverName: params.serverName, authorizationUrl: result.authorizationUrl },
      },
    };
  }
  if (sent.status === "unavailable") {
    return failure(
      `Private sign-in delivery for MCP server "${params.serverName}" is unavailable for this request. ` +
        "Ask the operator to check the channel plugin and originating bot account, then try connecting again. No sign-in link was posted to this conversation.",
    );
  }
  if (sent.status !== "sent") {
    return failure(
      `Could not privately deliver the sign-in link for MCP server "${params.serverName}". ` +
        "Allow private messages from this bot and ask the operator to check its private messaging access, then try connecting again. No sign-in link was posted to this conversation.",
    );
  }
  return {
    content: [
      {
        type: "text",
        text:
          `Sent you a private message with the sign-in link for MCP server "${params.serverName}". ` +
          "Complete sign-in there, then return to this conversation. The server's tools become available on the next message.",
      },
    ],
    details: { mcpServer: params.serverName, status: "link-sent" },
  };
}

function buildRequesterConnectCatalog(
  serverNames: Iterable<string>,
  safeServerNamesByServer: ReadonlyMap<string, string>,
): McpToolCatalog {
  const entries = [...serverNames];
  return {
    version: 1,
    generatedAt: Date.now(),
    servers: Object.fromEntries(
      entries.map((serverName) => [
        serverName,
        {
          serverName,
          safeServerName: safeServerNamesByServer.get(serverName),
          launchSummary: "Requester OAuth",
          toolCount: 1,
        },
      ]),
    ),
    tools: entries.map((serverName) => ({
      serverName,
      safeServerName: safeServerNamesByServer.get(serverName) ?? serverName,
      toolName: "connect",
      description: `Connect your ${serverName} account. Sign-in is delivered privately when this channel supports it.`,
      fallbackDescription: `Connect your ${serverName} account. Sign-in is delivered privately when this channel supports it.`,
      inputSchema: Type.Object({}),
      oauthConnectBootstrap: true,
    })),
  };
}

/** Builds the per-message requester sign-in surface without opening MCP transports. */
export async function createRequesterMcpConnect(params: {
  serverNames: ReadonlySet<string>;
  mcpServers: Record<string, BundleMcpServerConfig>;
  safeServerNamesByServer: ReadonlyMap<string, string>;
  requesterScope: SessionMcpRequesterScope;
  cfg?: OpenClawConfig;
  configFingerprint: string;
}): Promise<RequesterMcpConnect | undefined> {
  const servers = new Map<
    string,
    (
      delivery?: RequesterMcpConnectDelivery,
      signal?: AbortSignal,
    ) => Promise<AgentToolResult<unknown>>
  >();
  const authorizedServerNames: string[] = [];
  for (const serverName of [...params.serverNames].toSorted((a, b) => a.localeCompare(b))) {
    const resolved = resolveMcpTransportConfig(serverName, params.mcpServers[serverName], {
      logWarnings: false,
    });
    if (
      resolved?.kind !== "http" ||
      resolved.auth !== "oauth" ||
      resolved.oauth?.identity !== "per-requester"
    ) {
      continue;
    }
    const [identity, oauth] = await Promise.all([
      import("./mcp-oauth-identity.js"),
      import("./mcp-oauth.js"),
    ]);
    servers.set(serverName, (delivery, signal) =>
      connectRequesterOAuthServer({
        serverName,
        publicOrigin: params.cfg?.gateway?.publicOrigin,
        delivery,
        signal,
        authorize: (redirectUrl) =>
          oauth.startMcpOAuthAuthorization(
            identity.requesterMcpOAuthIdentity(serverName, resolved.url, params.requesterScope),
            resolved,
            { redirectUrl },
          ),
      }),
    );
    const status = await oauth.readMcpOAuthCredentialsStatus(
      identity.requesterMcpOAuthIdentity(serverName, resolved.url, params.requesterScope),
    );
    if (status.state === "authorized") {
      authorizedServerNames.push(serverName);
    }
  }
  if (servers.size === 0) {
    return undefined;
  }
  const configFingerprint = JSON.stringify({
    config: params.configFingerprint,
    authorizedServerNames,
    publicOrigin: params.cfg?.gateway?.publicOrigin,
  });
  return {
    catalog: buildRequesterConnectCatalog(servers.keys(), params.safeServerNamesByServer),
    authorizedServerNames,
    configFingerprint,
    createExecute(serverName, delivery) {
      const execute = servers.get(serverName);
      return execute
        ? async (_toolCallId, _input, signal) => await execute(delivery, signal)
        : undefined;
    },
  };
}

/** Adds transient connect entries only for servers absent from the live catalog. */
export function mergeMcpConnectCatalog(
  liveCatalog: McpToolCatalog,
  requesterConnect?: RequesterMcpConnect,
): McpToolCatalog {
  const connectCatalog = requesterConnect?.catalog;
  if (!connectCatalog) {
    return liveCatalog;
  }
  const missingServerNames = new Set(
    Object.keys(connectCatalog.servers).filter(
      (serverName) => !Object.hasOwn(liveCatalog.servers, serverName),
    ),
  );
  if (missingServerNames.size === 0) {
    return liveCatalog;
  }
  return {
    ...liveCatalog,
    generatedAt: Math.max(liveCatalog.generatedAt, connectCatalog.generatedAt),
    servers: {
      ...liveCatalog.servers,
      ...Object.fromEntries(
        Object.entries(connectCatalog.servers).filter(([serverName]) =>
          missingServerNames.has(serverName),
        ),
      ),
    },
    tools: [
      ...liveCatalog.tools,
      ...connectCatalog.tools.filter((tool) => missingServerNames.has(tool.serverName)),
    ].toSorted(
      (left, right) =>
        left.safeServerName.localeCompare(right.safeServerName) ||
        left.toolName.localeCompare(right.toolName) ||
        left.serverName.localeCompare(right.serverName),
    ),
  };
}
