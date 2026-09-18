import { embeddedAgentLog, OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parse as parseSemver } from "semver";
import type { CodexAppServerClient, CodexAppServerRuntimeIdentity } from "./client.js";
import type { CodexInitializeParams, CodexInitializeResponse } from "./protocol.js";
import { CODEX_APP_SERVER_VERSION, MIN_SUPPORTED_CODEX_APP_SERVER_VERSION } from "./version.js";

/** Negotiates connection capabilities and validates the responding app-server identity. */
export async function requestCodexAppServerInitialize(
  client: Pick<CodexAppServerClient, "request">,
): Promise<CodexAppServerRuntimeIdentity> {
  // The handshake identifies the exact app-server process we will keep using,
  // which matters when callers override the binary or app-server args.
  const response = await client.request("initialize", {
    clientInfo: {
      name: "openclaw",
      title: "OpenClaw",
      version: OPENCLAW_VERSION,
    },
    capabilities: {
      experimentalApi: true,
      // Codex 0.154.0's app-server-protocol/src/protocol/common.rs inventory,
      // audited against client/runtime, turn router/projectors, catalog, and native
      // subagent consumers. Keep turn-scoped events for progress/receipt ownership;
      // remove an opt-out here before adding a consumer.
      optOutNotificationMethods: [
        "account/login/completed",
        "app/list/updated",
        "command/exec/outputDelta",
        "deprecationNotice",
        "externalAgentConfig/import/completed",
        "externalAgentConfig/import/progress",
        "fs/changed",
        "fuzzyFileSearch/sessionCompleted",
        "fuzzyFileSearch/sessionUpdated",
        "mcpServer/event/stream/notification",
        "mcpServer/oauthLogin/completed",
        "mcpServer/startupStatus/updated",
        "process/exited",
        "process/outputDelta",
        "project/changed",
        "remoteControl/status/changed",
        "thread/environment/connected",
        "thread/environment/disconnected",
        "thread/goal/cleared",
        "thread/project/updated",
        "thread/queue/changed",
        "thread/realtime/closed",
        "thread/realtime/error",
        "thread/realtime/item/completed",
        "thread/realtime/item/started",
        "thread/realtime/item/transcript/delta",
        "thread/realtime/itemAdded",
        "thread/realtime/outputAudio/delta",
        "thread/realtime/sdp",
        "thread/realtime/started",
        "thread/realtime/transcript/delta",
        "thread/realtime/transcript/done",
        "windows/worldWritableWarning",
        "windowsSandbox/setupCompleted",
      ],
      extensions: {
        "openai/standard-form-input": {},
        "openai/form": {},
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    },
  } satisfies CodexInitializeParams);
  const serverVersion = assertSupportedCodexAppServerVersion(response);
  return buildCodexAppServerRuntimeIdentity(response, serverVersion);
}

/** Raised when the initialize handshake detects an unsupported app-server version. */
export class CodexAppServerVersionError extends Error {
  readonly detectedVersion?: string;

  constructor(detectedVersion: string | undefined) {
    const detected = detectedVersion
      ? `detected ${detectedVersion}`
      : "OpenClaw could not determine the running Codex version";
    super(
      `Codex app-server ${MIN_SUPPORTED_CODEX_APP_SERVER_VERSION} or newer is required, but ${detected}. Update the configured Codex app-server binary, or remove custom command overrides to use the managed binary.`,
    );
    this.name = "CodexAppServerVersionError";
    this.detectedVersion = detectedVersion;
  }
}

function assertSupportedCodexAppServerVersion(response: CodexInitializeResponse): string {
  const detectedVersion = readCodexVersionFromUserAgent(response.userAgent);
  if (!detectedVersion) {
    throw new CodexAppServerVersionError(detectedVersion);
  }
  const detected = parseSemver(detectedVersion);
  if (!detected || detected.compare(MIN_SUPPORTED_CODEX_APP_SERVER_VERSION) < 0) {
    throw new CodexAppServerVersionError(detectedVersion);
  }
  if (detected.compare(CODEX_APP_SERVER_VERSION) > 0) {
    embeddedAgentLog.warn(
      "codex app-server is newer than OpenClaw's managed runtime; continuing with normal startup validation",
      {
        detectedVersion,
        validatedVersion: CODEX_APP_SERVER_VERSION,
      },
    );
  }
  return detectedVersion;
}

function buildCodexAppServerRuntimeIdentity(
  response: CodexInitializeResponse,
  serverVersion: string,
): CodexAppServerRuntimeIdentity {
  const userAgent = normalizeOptionalString(response.userAgent);
  const codexHome = normalizeOptionalString(response.codexHome);
  const platformFamily = normalizeOptionalString(response.platformFamily);
  const platformOs = normalizeOptionalString(response.platformOs);
  return {
    serverVersion,
    ...(userAgent ? { userAgent } : {}),
    ...(codexHome ? { codexHome } : {}),
    ...(platformFamily ? { platformFamily } : {}),
    ...(platformOs ? { platformOs } : {}),
  };
}

/** Extracts the Codex version from the app-server initialize user-agent field. */
function readCodexVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  // Codex returns `<originator>/<codex-version> ...`; the originator can be
  // OpenClaw, Codex Desktop, or an env override, so only the slash-delimited
  // version in the leading product field is stable.
  const match = userAgent?.match(
    /^[^/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:[\s(]|$)/,
  );
  return match?.[1];
}
