import { readFileSync } from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { buildTrackingLink, verifyTrackingLink } from "./src/attribution.js";
import { appendLedgerEntry, defaultLedgerPath, readLedgerEntries } from "./src/ledger.js";
import { stampImage } from "./src/stamp.js";

// Same convention as /root/.openclaw/web-bridge-secret (see
// kora-profile/index.ts): the gateway's systemd unit does not source an
// EnvironmentFile, so a bare env var never reaches the running process on
// the VM. A plain secret file next to the other KORA secrets does.
const SECRET_FILE = "/root/.openclaw/growth-attribution-secret";

function resolveSecret(api: OpenClawPluginApi, explicit?: string): string {
  let fileSecret: string | undefined;
  try {
    fileSecret = readFileSync(SECRET_FILE, "utf8").trim() || undefined;
  } catch {
    // Fine off the VM (local dev, tests) — env/config fallbacks below cover that.
  }
  const secret =
    explicit ??
    process.env.GROWTH_ATTRIBUTION_SECRET ??
    fileSecret ??
    (api.pluginConfig?.secret as string | undefined);
  if (!secret) {
    throw new Error(
      `growth-attribution: no secret configured (set GROWTH_ATTRIBUTION_SECRET, put one in ${SECRET_FILE}, or set plugin config \`secret\`)`,
    );
  }
  return secret;
}

function ledgerPathFor(api: OpenClawPluginApi): string {
  try {
    const stateDir = api.runtime.state.resolveStateDir();
    return path.join(stateDir, "growth-attribution", "ledger.jsonl");
  } catch {
    return defaultLedgerPath();
  }
}

export default function register(api: OpenClawPluginApi) {
  api.registerCli(
    ({ program }) => {
      const growth = program.command("growth").description("Growth attribution tooling");

      growth
        .command("link <url>")
        .description("Generate a signed, attributable tracking link")
        .requiredOption("--by <name>", "growth team member issuing the link")
        .requiredOption("--platform <platform>", "destination platform, e.g. reddit")
        .option("--campaign <campaign>", "campaign label", "growth")
        .option("--medium <medium>", "utm_medium", "social")
        .option("--secret <secret>", "signing secret (defaults to $GROWTH_ATTRIBUTION_SECRET)")
        .action((url: string, opts) => {
          const secret = resolveSecret(api, opts.secret);
          const result = buildTrackingLink({
            url,
            growerName: opts.by,
            platform: opts.platform,
            campaign: opts.campaign,
            medium: opts.medium,
            secret,
          });
          appendLedgerEntry(ledgerPathFor(api), {
            id: result.id,
            kind: "link",
            growerName: result.growerName,
            platform: result.platform,
            campaign: result.campaign,
            timestampMs: result.timestampMs,
            sig: result.sig,
            url: result.url,
          });
          console.log(result.url);
        });

      growth
        .command("stamp <imagePath>")
        .description("Overlay a name/platform/timestamp watermark on an image")
        .requiredOption("--by <name>", "growth team member issuing the image")
        .requiredOption("--platform <platform>", "destination platform, e.g. reddit")
        .option("--campaign <campaign>", "label appended to the stamp")
        .option("--out <outputPath>", "output path (defaults next to input with .stamped suffix)")
        .action(async (imagePath: string, opts) => {
          const ext = path.extname(imagePath);
          const outputPath = opts.out ?? imagePath.replace(new RegExp(`${ext}$`), `.stamped${ext}`);
          const result = await stampImage({
            inputPath: imagePath,
            outputPath,
            growerName: opts.by,
            platform: opts.platform,
            label: opts.campaign,
          });
          appendLedgerEntry(ledgerPathFor(api), {
            id: `img-${result.timestampMs}`,
            kind: "image",
            growerName: result.growerName,
            platform: result.platform,
            campaign: opts.campaign ?? "growth",
            timestampMs: result.timestampMs,
            sig: "",
            imagePath: result.outputPath,
          });
          console.log(result.outputPath);
        });

      growth
        .command("verify <url>")
        .description("Verify a tracking link's signature")
        .option("--secret <secret>", "signing secret (defaults to $GROWTH_ATTRIBUTION_SECRET)")
        .action((url: string, opts) => {
          const secret = resolveSecret(api, opts.secret);
          console.log(JSON.stringify(verifyTrackingLink(url, secret), null, 2));
        });

      growth
        .command("list")
        .description("List issued tracking links/images for backtest QC")
        .option("--by <name>", "filter by grower name")
        .option("--platform <platform>", "filter by platform")
        .action((opts) => {
          const entries = readLedgerEntries(ledgerPathFor(api), {
            growerName: opts.by,
            platform: opts.platform,
          });
          console.log(JSON.stringify(entries, null, 2));
        });
    },
    { commands: ["growth"] },
  );

  api.registerCommand({
    name: "growlink",
    description:
      "Generate a signed growth-attribution tracking link: /growlink <name> <platform> <url> [campaign]",
    acceptsArgs: true,
    handler: (ctx) => {
      const tokens = (ctx.args ?? "").trim().split(/\s+/).filter(Boolean);
      const [growerName, platform, url, campaign] = tokens;
      if (!growerName || !platform || !url) {
        return { text: "Usage: /growlink <name> <platform> <url> [campaign]" };
      }
      try {
        const secret = resolveSecret(api);
        const result = buildTrackingLink({ url, growerName, platform, campaign, secret });
        appendLedgerEntry(ledgerPathFor(api), {
          id: result.id,
          kind: "link",
          growerName: result.growerName,
          platform: result.platform,
          campaign: result.campaign,
          timestampMs: result.timestampMs,
          sig: result.sig,
          url: result.url,
        });
        return { text: result.url };
      } catch (err) {
        return { text: `growlink failed: ${(err as Error).message}`, isError: true };
      }
    },
  });
}
