// Ollama tests cover provider models.ssrf plugin behavior.
import { describe, expect, it } from "vitest";
import { buildOllamaBaseUrlSsrFPolicy, buildOllamaEmbeddingSsrFPolicy } from "./provider-models.js";

describe("buildOllamaBaseUrlSsrFPolicy", () => {
  it("pins requests to the configured Ollama hostname for HTTP(S) URLs", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("http://127.0.0.1:11434")).toEqual({
      hostnameAllowlist: ["127.0.0.1"],
      allowPrivateNetwork: true,
    });
    expect(buildOllamaBaseUrlSsrFPolicy("http://192.168.1.10:11434")).toEqual({
      hostnameAllowlist: ["192.168.1.10"],
      allowPrivateNetwork: true,
    });
    expect(buildOllamaBaseUrlSsrFPolicy("https://ollama.example.com/v1")).toEqual({
      hostnameAllowlist: ["ollama.example.com"],
      allowPrivateNetwork: true,
    });
  });

  it("opts into private-network access for explicit Ollama hosts", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("http://localhost:11434")).toEqual({
      hostnameAllowlist: ["localhost"],
      allowPrivateNetwork: true,
    });
    expect(buildOllamaBaseUrlSsrFPolicy("http://[fd00::1]:11434")).toEqual({
      hostnameAllowlist: ["[fd00::1]"],
      allowPrivateNetwork: true,
    });
    expect(buildOllamaBaseUrlSsrFPolicy("https://ollama.local:11434")).toEqual({
      hostnameAllowlist: ["ollama.local"],
      allowPrivateNetwork: true,
    });
  });

  it("returns no allowlist for empty or invalid base URLs", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("ftp://ollama.example.com")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("not-a-url")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("http://metadata.google.internal")).toBeUndefined();
  });
});

describe("buildOllamaEmbeddingSsrFPolicy", () => {
  it("pins to the configured hostname and exact origin, without allowPrivateNetwork", () => {
    expect(buildOllamaEmbeddingSsrFPolicy("http://127.0.0.1:11434")).toEqual({
      hostnameAllowlist: ["127.0.0.1"],
      allowedOrigins: ["http://127.0.0.1:11434"],
      allowUnspecifiedIpv4Range: true,
    });
    expect(buildOllamaEmbeddingSsrFPolicy("https://ollama.example.com/v1")).toEqual({
      hostnameAllowlist: ["ollama.example.com"],
      allowedOrigins: ["https://ollama.example.com"],
      allowUnspecifiedIpv4Range: true,
    });
  });

  it("scopes trust to the exact origin (including port), unlike a flat hostname allowlist", () => {
    const policy = buildOllamaEmbeddingSsrFPolicy("http://model.lan:11434");
    expect(policy?.allowedOrigins).toEqual(["http://model.lan:11434"]);
    // A same-hostname, different-port origin is deliberately NOT in the allowlist — see
    // src/infra/net/ssrf.ts's resolveSsrFPolicyForUrl, which only promotes hostname trust
    // for a request whose URL origin exactly matches.
    expect(policy?.allowedOrigins).not.toContain("http://model.lan:9999");
  });

  it("never sets allowPrivateNetwork (that would waive loopback/link-local/cloud-metadata protections too)", () => {
    expect(
      buildOllamaEmbeddingSsrFPolicy("http://127.0.0.1:11434")?.allowPrivateNetwork,
    ).toBeUndefined();
    expect(
      buildOllamaEmbeddingSsrFPolicy("http://host.docker.internal:11434")?.allowPrivateNetwork,
    ).toBeUndefined();
  });

  it("returns no allowlist for empty or invalid base URLs", () => {
    expect(buildOllamaEmbeddingSsrFPolicy("")).toBeUndefined();
    expect(buildOllamaEmbeddingSsrFPolicy("ftp://ollama.example.com")).toBeUndefined();
    expect(buildOllamaEmbeddingSsrFPolicy("not-a-url")).toBeUndefined();
    expect(buildOllamaEmbeddingSsrFPolicy("http://metadata.google.internal")).toBeUndefined();
  });
});
