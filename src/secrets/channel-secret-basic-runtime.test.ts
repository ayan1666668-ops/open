/** Regression tests for bracket-quoted account keys in channel secret assignment paths. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it } from "vitest";
import { coerceConfig, resolveConfigForRead } from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import {
  collectSimpleChannelFieldAssignments,
  resolveChannelAccountSurface,
} from "./channel-secret-basic-runtime.js";
import { createResolverContext } from "./runtime-shared.js";

describe("collectSimpleChannelFieldAssignments", () => {
  it("finds authored env refs for account keys that need bracket quoting", () => {
    const read = resolveConfigForRead(
      {
        channels: {
          discord: {
            accounts: {
              "0": { token: "${ACCOUNT_ZERO_TOKEN}" },
              "prod.guild": { token: "${ACCOUNT_DOTTED_TOKEN}" },
            },
          },
        },
      },
      {},
    );
    const sourceConfig = coerceConfig(read.resolvedConfigRaw);
    setConfigResolutionFacts(sourceConfig, read.resolutionFacts);
    const channel = asOptionalRecord(sourceConfig.channels?.discord);
    assert(channel);
    const context = createResolverContext({ sourceConfig, env: {} });

    collectSimpleChannelFieldAssignments({
      channelKey: "discord",
      field: "token",
      channel,
      surface: resolveChannelAccountSurface(channel),
      defaults: undefined,
      context,
      topInactiveReason: "inactive",
      accountInactiveReason: "inactive account",
    });

    const refByPath = new Map(
      context.assignments.map((assignment) => [assignment.path, assignment.ref]),
    );
    expect([...refByPath.keys()].toSorted()).toEqual([
      'channels.discord.accounts["0"].token',
      'channels.discord.accounts["prod.guild"].token',
    ]);
    expect(refByPath.get('channels.discord.accounts["0"].token')).toEqual({
      source: "env",
      provider: "default",
      id: "ACCOUNT_ZERO_TOKEN",
    });
    expect(refByPath.get('channels.discord.accounts["prod.guild"].token')).toEqual({
      source: "env",
      provider: "default",
      id: "ACCOUNT_DOTTED_TOKEN",
    });
  });
});
