// Product security review belongs to maintainers. SecOps-only enforcement paths
// live in .github/CODEOWNERS; this inventory supplies actionable review reasons.
const securitySensitiveRules = [
  {
    reason: "Controls which local files and secrets can accidentally enter version control.",
    paths: [/^\.gitignore$/u],
  },
  {
    reason:
      "Controls Gateway authentication, pairing, or caller permissions. Check identity validation, scope checks, and revocation.",
    paths: [
      /^src\/gateway\/(?:.*\/)?[^/]*(?:auth|pairing|role-policy|operator-role|operator-scopes|method-scopes|session-method-policy|device-scope|device-management|device-revocation|device-worker-revocation|security-path)[^/]*\.ts$/u,
      /^src\/gateway\/server\/ws-connection\//u,
      /^src\/gateway\/(?:server-http|server-methods|server\/ws-connection|http-utils|server-methods\/devices|server-methods\/device-pair-setup)\.ts$/u,
      /^src\/infra\/(?:device-auth|device-pairing|device-bootstrap|node-pairing|pairing|state-migrations\.(?:pairing|channel-pairing))[^/]*\.ts$/u,
      /^src\/pairing\//u,
      /^src\/gateway\/methods\//u,
      /^src\/gateway\/(?:origin-check|server\/ws-origin-policy)\.ts$/u,
      /^src\/shared\/(?:operator-scope-compat|device-bootstrap-profile|gateway-method-policy|session-method-scopes[^/]*)\.ts$/u,
    ],
  },
  {
    reason:
      "Controls credential persistence, secret resolution, or redaction. Check storage permissions, credential scope, and exposure in logs or responses.",
    paths: [
      /^src\/secrets\//u,
      /^src\/agents\/auth-profiles(?:\/|[^/]*\.ts$)/u,
      /^src\/(?:agents|config|gateway|infra|logging|plugins|proxy-capture|state)\/(?:.*\/)?[^/]*(?:auth-store|credential|secret|redact)[^/]*\.ts$/u,
      /^src\/agents\/(?:.*\/)?[^/]*auth[^/]*\.ts$/u,
      /^packages\/(?:acp-core|ai|gateway-protocol|memory-host-sdk|net-policy|plugin-sdk)\/src\/(?:.*\/)?[^/]*(?:credential|secret|redact)[^/]*\.ts$/u,
      /^apps\/(?:ios|shared\/OpenClawKit)\/Sources\/(?:.*\/)?[^/]*(?:KeychainStore|DeviceAuthStore)\.swift$/u,
      /^apps\/android\/app\/src\/main\/java\/ai\/openclaw\/app\/(?:SecurePrefs|gateway\/DeviceAuthStore)\.kt$/u,
    ],
  },
  {
    reason:
      "Controls sandbox containment or tool execution authority. Check filesystem and network isolation, approval scope, and command allowlists.",
    paths: [
      /^src\/agents\/agent-tools\.policy\.ts$/u,
      /^src\/agents\/sandbox(?:\/|[^/]*\.ts$)/u,
      /^src\/agents\/(?:.*\/)?[^/]*(?:sandbox|tool-policy|exec-approval|exec-auto-review|exec-tool-target)[^/]*\.ts$/u,
      /^src\/infra\/exec-(?:approval|allow|safe|policy|wrapper-trust)[^/]*\.ts$/u,
      /^src\/node-host\/(?:.*\/)?[^/]*(?:exec-policy|exec-approval)[^/]*\.ts$/u,
      /^src\/gateway\/(?:.*\/)?[^/]*(?:exec-approval|sandbox|node-command-policy)[^/]*\.ts$/u,
      /^src\/config\/(?:types|zod-schema)\.(?:agents|tools|sandbox)[^/]*\.ts$/u,
      /^packages\/(?:gateway-protocol|plugin-sdk)\/src\/(?:.*\/)?[^/]*(?:exec-approval|sandbox|tool-policy)[^/]*\.ts$/u,
    ],
  },
  {
    reason:
      "Controls product security checks or trust decisions. Check whether the change weakens detection, protection, or remediation.",
    paths: [/^src\/security\//u, /^src\/skills\/security\//u],
  },
];

function isReviewablePath(filename) {
  return (
    typeof filename === "string" &&
    !/(?:^|\/)(?:__tests__|tests?|fixtures?|test-support|test-helpers)(?:\/|$)/iu.test(filename) &&
    !/\.(?:test|spec|suite)\.|(?:^|[./-])(?:test-support|test-helpers?|fixtures?|bench)(?:[./-]|$)/u.test(
      filename,
    ) &&
    !/\.(?:md|mdx)$/iu.test(filename)
  );
}

export function collectSecuritySensitiveChanges(files) {
  const changes = new Map();
  for (const file of files) {
    const filenames = typeof file === "string" ? [file] : [file?.filename, file?.previous_filename];
    for (const filename of filenames) {
      if (!isReviewablePath(filename)) {
        continue;
      }
      const rule = securitySensitiveRules.find((entry) =>
        entry.paths.some((pattern) => pattern.test(filename)),
      );
      if (rule) {
        changes.set(filename, { path: filename, reason: rule.reason });
      }
    }
  }
  return [...changes.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}
