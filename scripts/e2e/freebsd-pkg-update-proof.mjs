#!/usr/bin/env node
// Temporary proof payload. Remove with its workflow after the native receipt.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "77fab5c84cf45c6163174d945f6c75c18cadec37";
const PKG_VERSION = "2.8.4";
const PUBLISHED_VERSION = "2026.9.4";
const PUBLISHED_SHA512 =
  "9534291047b55e6deed8f08768f12bfaf3fca5a1a4d6f2dd1eecdd22db0d4e868b23a840a9156f809620f86c6e9098444c9a78b4fcbf4b519fb65e0ab81f27ec";
const WORKFLOW = ".github/workflows/freebsd-pkg-update-proof.yml";
const PRODUCER = "Build FreeBSD update proof package";
const FILES = [
  "first-hop-fixture.json",
  "openclaw-candidate.tgz",
  "openclaw-first-hop.tgz",
  "openclaw-published.tgz",
  "pack.json",
  "source.json",
];
const here = fileURLToPath(import.meta.url);
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (file, algorithm = "sha256") =>
  createHash(algorithm).update(fs.readFileSync(file)).digest("hex");
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function command(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${file} terminated by signal`);
  return result;
}

function success(file, args, options) {
  const result = command(file, args, options);
  assert.equal(
    result.status,
    0,
    `${file} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function output(name, value) {
  assert(!String(value).includes("\n"));
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function api(suffix) {
  assert.equal(process.env.GITHUB_REPOSITORY, "openclaw/openclaw");
  assert(process.env.GH_TOKEN, "host artifact read token missing");
  const response = await fetch(`https://api.github.com/repos/openclaw/openclaw/${suffix}`, {
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `GitHub metadata ${suffix}: HTTP ${response.status}`);
  return await response.json();
}

function verifyFiles(directory) {
  assert.deepEqual(fs.readdirSync(directory).toSorted(), FILES);
  assert.equal(hash(path.join(directory, "openclaw-published.tgz"), "sha512"), PUBLISHED_SHA512);
  const manifest = json(path.join(directory, "source.json"));
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert(FILES.includes(name) && name !== "source.json");
    const file = path.join(directory, name);
    assert(fs.lstatSync(file).isFile());
    assert.equal(hash(file), expected.sha256, `${name} SHA256`);
    assert.equal(hash(file, "sha512"), expected.sha512, `${name} SHA512`);
  }
  assert.deepEqual(
    Object.keys(manifest.files).toSorted(),
    FILES.filter((name) => name !== "source.json"),
  );
  assert.equal(
    hash(here),
    manifest.fixtureSha256,
    "native fixture differs from the producer source",
  );
  const hop = json(path.join(directory, "first-hop-fixture.json"));
  assert.equal(hop.method, "candidate-same-schema-first-hop-fixture");
  assert.equal(hop.sourceSha256, manifest.files["openclaw-candidate.tgz"].sha256);
  assert.equal(hop.targetSha256, manifest.files["openclaw-first-hop.tgz"].sha256);
  assert.notEqual(hop.sourceVersion, hop.targetVersion);
  return manifest;
}

async function stamp(directory) {
  const sourceSha = success("git", ["rev-parse", "HEAD"]);
  assert.equal(sourceSha, process.env.SOURCE_SHA);
  assert.equal(success("git", ["status", "--porcelain"]), "");
  const run = await api(
    `actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`,
  );
  assert.equal(run.event, "pull_request");
  assert.equal(run.head_branch, process.env.SOURCE_BRANCH);
  assert.equal(run.path, WORKFLOW);
  // Explicit reviewed product/test scope; shallow Actions checkout needs no history download.
  const changed = [
    "src/cli/update-cli/shared.ts",
    "src/cli/update-cli/update-command-execution.ts",
    "src/cli/update-cli/update-command-freebsd-pkg.test.ts",
    "src/cli/update-cli/update-command-fresh.test-support.ts",
    "src/cli/update-cli/update-command-git.ts",
    "src/cli/update-cli/update-command-package-runtime.ts",
    "src/cli/update-cli/update-command-package.ts",
    "src/cli/update-cli/update-command-post-update.ts",
    "src/cli/update-cli/update-command-result.ts",
    "src/cli/update-cli/update-command-run.ts",
    "src/cli/update-cli/update-command-service-plan.ts",
    "src/cli/update-cli/update-command-target.ts",
    "src/cli/update-cli/update-command-wrapper-retirement.test.ts",
    "src/cli/update-cli/update-command.ts",
    "src/gateway/server-methods/update-admission.ts",
    "src/gateway/server-methods/update-freebsd-pkg.test.ts",
    "src/gateway/server-methods/update.ts",
    "src/infra/package-update-filesystem.ts",
    "src/infra/package-update-steps.ts",
    "src/infra/package-update-swap-contract.ts",
    "src/infra/package-update-swap.freebsd.test.ts",
    "src/infra/package-update-swap.test.ts",
    "src/infra/package-update-swap.ts",
    "src/infra/update-freebsd-pkg-ownership.test-support.ts",
    "src/infra/update-freebsd-pkg-ownership.test.ts",
    "src/infra/update-freebsd-pkg-ownership.ts",
    "src/infra/update-global.freebsd.test.ts",
    "src/infra/update-global.ts",
  ];
  const sourceBlobs = changed.map((file) => ({
    path: file,
    kind: /\.test(?:-support)?\.ts$/u.test(file) ? "test" : "production",
    blob: success("git", ["rev-parse", `HEAD:${file}`]),
    sha256: hash(file),
  }));
  const manifest = {
    sourceSha,
    baseSha: BASE,
    sourceBlobs,
    workflowContextSha: process.env.GITHUB_SHA,
    workflowRunHeadSha: run.head_sha,
    runId: run.id,
    runAttempt: run.run_attempt,
    branch: run.head_branch,
    lockSha256: hash("pnpm-lock.yaml"),
    fixtureSha256: hash(here),
    builderNode: process.version,
    pkgVersion: PKG_VERSION,
    pkgSource: `https://github.com/freebsd/pkg/tree/${PKG_VERSION}`,
    files: Object.fromEntries(
      FILES.filter((name) => name !== "source.json").map((name) => [
        name,
        {
          sha256: hash(path.join(directory, name)),
          sha512: hash(path.join(directory, name), "sha512"),
        },
      ]),
    ),
  };
  fs.writeFileSync(path.join(directory, "source.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  verifyFiles(directory);
  output("source-sha", sourceSha);
  output("run-head-sha", run.head_sha);
  output("manifest-sha", hash(path.join(directory, "source.json")));
  output("candidate-sha", manifest.files["openclaw-candidate.tgz"].sha256);
  output("first-hop-sha", manifest.files["openclaw-first-hop.tgz"].sha256);
  emit(manifest);
}

async function recordArtifact() {
  const artifact = await api(`actions/artifacts/${process.env.ARTIFACT_ID}`);
  const digest = process.env.UPLOAD_DIGEST.replace(/^sha256:/u, "");
  assert.equal(artifact.digest, `sha256:${digest}`);
  assert.equal(artifact.id, Number(process.env.ARTIFACT_ID));
  assert.equal(artifact.expired, false);
  output("artifact-digest", artifact.digest);
  output("artifact-size", artifact.size_in_bytes);
  emit({ artifactId: artifact.id, digest: artifact.digest, size: artifact.size_in_bytes });
}

async function verifyArtifact(directory) {
  const manifestFile = path.join(directory, "source.json");
  assert.equal(hash(manifestFile), process.env.MANIFEST_SHA);
  const manifest = verifyFiles(directory);
  assert.equal(manifest.sourceSha, process.env.SOURCE_SHA);
  assert.equal(success("git", ["rev-parse", "HEAD"]), manifest.sourceSha);
  assert.equal(manifest.files["openclaw-candidate.tgz"].sha256, process.env.CANDIDATE_SHA);
  assert.equal(manifest.files["openclaw-first-hop.tgz"].sha256, process.env.FIRST_HOP_SHA);
  const expected = {
    repository: "openclaw/openclaw",
    artifactId: Number(process.env.ARTIFACT_ID),
    artifactName: `freebsd-pkg-payload-${manifest.runId}-${manifest.runAttempt}`,
    artifactDigest: process.env.ARTIFACT_DIGEST,
    artifactSizeBytes: Number(process.env.ARTIFACT_SIZE),
    runId: manifest.runId,
    runAttempt: manifest.runAttempt,
    workflowSha: process.env.RUN_HEAD_SHA,
    workflowPath: WORKFLOW,
    workflowEvent: "pull_request",
    workflowHeadBranch: process.env.SOURCE_BRANCH,
    runStatePolicy: "same-run-producer-success",
    consumerRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    producerJobName: PRODUCER,
  };
  assert.equal(manifest.workflowRunHeadSha, expected.workflowSha);
  assert.equal(manifest.runId, Number(process.env.GITHUB_RUN_ID));
  const { validateActionsArtifactBinding, validateActionsArtifactProducerJob } =
    await import("../lib/actions-artifact-archive.mjs");
  const artifactMetadata = await api(`actions/artifacts/${expected.artifactId}`);
  const workflowRun = await api(`actions/runs/${expected.runId}/attempts/${expected.runAttempt}`);
  const workflowJobs = await api(
    `actions/runs/${expected.runId}/attempts/${expected.runAttempt}/jobs?per_page=100`,
  );
  validateActionsArtifactBinding({ artifactMetadata, workflowRun, expected });
  validateActionsArtifactProducerJob({ workflowJobs, expected });
  emit({ artifactVerified: expected, sourceSha: manifest.sourceSha });
}

async function shutdown(directory) {
  assert.equal(process.platform, "linux");
  assert.equal(directory, path.join(process.env.RUNNER_TEMP, "freebsd-pkg-vm"));
  const ownGuests = () =>
    fs
      .readdirSync("/proc")
      .filter((pid) => /^\d+$/u.test(pid))
      .filter((pid) => {
        try {
          const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
          return (
            path.basename(args[0]).startsWith("qemu-system-") &&
            args.some((arg) => arg.includes(`${directory}/`))
          );
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "ESRCH") {
            return false;
          }
          throw error;
        }
      });
  const before = ownGuests();
  if (before.length) {
    const config = success("ssh", ["-G", "freebsd"]);
    assert.match(config, /^hostname (?:127\.0\.0\.1|localhost)$/mu);
    // A powered-off guest can close SSH before it sends the remote exit status.
    const result = command("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "freebsd",
      "/sbin/shutdown",
      "-p",
      "now",
    ]);
    assert([0, 255].includes(result.status), "guest shutdown request failed");
    const deadline = Date.now() + 60_000;
    while (ownGuests().length && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
    }
  }
  assert.deepEqual(
    ownGuests(),
    [],
    "task VM still alive after shutdown; disposable runner teardown remains required",
  );
  emit({ guestCleanup: "stopped", ownedQemuPids: before });
}

function native(directory, architecture, publishedOnly = false) {
  assert.equal(process.platform, "freebsd");
  assert(["x86_64", "aarch64"].includes(architecture));
  assert.equal(process.arch, architecture === "x86_64" ? "x64" : "arm64");
  assert.equal(
    process.getuid(),
    0,
    "outer fixture needs disposable-VM package registration authority",
  );
  assert.match(success("/usr/bin/uname", ["-r"]), /^15\.1-/u);
  const manifest = verifyFiles(directory);
  const pkgEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: "/root",
    ALIAS: "query=query",
    PKG_ENABLE_PLUGINS: "no",
  };
  const pkg = (args) => success("/usr/sbin/pkg", ["-N", ...args], { env: pkgEnv });
  assert.equal(pkg(["--version"]), PKG_VERSION, "native pkg source contract changed");
  const task = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pkg-proof-"));
  fs.chmodSync(task, 0o755);
  const user = `ocproof${process.pid}`;
  const home = path.join(task, "home");
  const prefix = path.join(task, "npm prefix");
  const root = path.join(prefix, "lib/node_modules/openclaw");
  const launcher = path.join(prefix, "bin/openclaw");
  // The action's workspace parents need not be searchable by the fixture account.
  const candidate = path.join(task, "candidate.tgz");
  const target = path.join(task, "first-hop.tgz");
  const published = path.join(task, "published.tgz");
  for (const [name, destination] of [
    ["openclaw-candidate.tgz", candidate],
    ["openclaw-first-hop.tgz", target],
    ["openclaw-published.tgz", published],
  ]) {
    fs.copyFileSync(path.join(directory, name), destination);
    fs.chmodSync(destination, 0o644);
    assert.equal(hash(destination), manifest.files[name].sha256);
  }
  const hop = json(path.join(directory, "first-hop-fixture.json"));
  const registered = new Set();
  let userCreated = false;
  let restoreLayout;
  let lockedParent;
  try {
    success("/usr/sbin/pw", ["useradd", "-n", user, "-m", "-d", home, "-s", "/bin/sh"]);
    userCreated = true;
    const uid = Number(success("/usr/bin/id", ["-u", user]));
    const gid = Number(success("/usr/bin/id", ["-g", user]));
    assert(uid > 0 && gid > 0);
    const ownedDirectory = (file) => {
      fs.mkdirSync(file, { recursive: true, mode: 0o755 });
      fs.chownSync(file, uid, gid);
    };
    for (const file of [prefix, path.join(task, "tmp"), path.join(task, "cache")]) {
      ownedDirectory(file);
    }
    const userEnv = {
      PATH: `${prefix}/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      USER: user,
      LOGNAME: user,
      TMPDIR: path.join(task, "tmp"),
      LANG: "C.UTF-8",
      NO_COLOR: "1",
      npm_config_prefix: prefix,
      npm_config_cache: path.join(task, "cache"),
      npm_config_userconfig: path.join(home, ".npmrc"),
    };
    fs.writeFileSync(userEnv.npm_config_userconfig, "");
    fs.chownSync(userEnv.npm_config_userconfig, uid, gid);
    const asUser = { uid, gid, env: userEnv, cwd: home };
    const identity = JSON.parse(
      success(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups()}))",
        ],
        asUser,
      ),
    );
    assert.equal(identity.uid, uid);
    assert.equal(identity.gid, gid);
    assert(!identity.groups.includes(0));
    const inventoryStart = Date.now();
    const inventory = success("/usr/sbin/pkg", ["-N", "query", "-a", "%Fp"], {
      ...asUser,
      env: { ...userEnv, ALIAS: "query=query", PKG_ENABLE_PLUGINS: "no" },
    }).split("\n");
    const packages = pkg(["query", "-a", "%n-%v"]).split("\n");
    assert(packages.some((name) => name.startsWith("node24-")));
    assert(packages.some((name) => name.startsWith("npm-node24-")));
    assert(inventory.length > 100, "requires a real Node/npm package inventory");
    emit({
      native: success("/usr/bin/uname", ["-m"]),
      node: process.version,
      libuv: process.versions.uv,
      pkg: PKG_VERSION,
      packages,
      pkgFiles: inventory.length,
      inventoryMs: Date.now() - inventoryStart,
      identity,
    });
    const install = (tarball) => {
      process.stdout.write(
        success("/usr/local/bin/npm", ["install", "--global", "--prefix", prefix, tarball], {
          ...asUser,
          timeout: 300_000,
        }) + "\n",
      );
    };
    const installed = () => json(path.join(root, "package.json")).version;
    const entry = (file) => {
      const stat = fs.lstatSync(file);
      return {
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        size: stat.isDirectory() ? null : stat.size,
        content: stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? hash(file) : null,
      };
    };
    const packageSnapshot = (packageRoot = root) =>
      [
        packageRoot,
        path.join(packageRoot, "package.json"),
        path.join(packageRoot, "openclaw.mjs"),
        path.join(packageRoot, "dist/build-info.json"),
      ].map(entry);
    if (publishedOnly) {
      const artifactBuildInfo = (tarball) =>
        JSON.parse(success("/usr/bin/tar", ["-xOf", tarball, "package/dist/build-info.json"]));
      install(published);
      assert.equal(installed(), PUBLISHED_VERSION);
      assert.deepEqual(json(path.join(root, "dist/build-info.json")), artifactBuildInfo(published));
      const state = path.join(task, "published-driver-state");
      ownedDirectory(state);
      const env = {
        ...userEnv,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      };
      const entrypoint = path.join(root, "openclaw.mjs");
      success(process.execPath, [entrypoint, "config", "set", "gateway.mode", "local"], {
        ...asUser,
        env,
        timeout: 120_000,
      });
      const stateDatabase = path.join(state, "state/openclaw.sqlite");
      const stateIdentity = fs.statSync(stateDatabase);
      const beforePackage = packageSnapshot();
      const beforeLauncher = entry(launcher);
      const beforeSiblings = fs.readdirSync(path.dirname(root)).toSorted();
      const beforeBuild = hash(path.join(root, "dist/build-info.json"));
      const runUpdate = () => {
        const result = command(
          process.execPath,
          [entrypoint, "update", "--tag", target, "--yes", "--no-restart", "--json"],
          { ...asUser, env, timeout: 480_000 },
        );
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        return result;
      };
      // The released driver has no FreeBSD process identity reader. It cannot
      // acquire the new candidate's checks before its own admission succeeds.
      const prior = runUpdate();
      assert.equal(prior.status, 1, "published updater must refuse before replacement");
      assert.match(
        `${prior.stdout}\n${prior.stderr}`,
        /managed handoff process start identity is unavailable/u,
      );
      assert.deepEqual(packageSnapshot(), beforePackage);
      assert.deepEqual(entry(launcher), beforeLauncher);
      assert.deepEqual(fs.readdirSync(path.dirname(root)).toSorted(), beforeSiblings);
      emit({
        case: "published updater preserves installation on missing FreeBSD identity",
        publishedVersion: PUBLISHED_VERSION,
        publishedSha512: PUBLISHED_SHA512,
        publishedBuildSha256: beforeBuild,
        packageIdentity: beforePackage,
      });

      // Bootstrap through the original installation owner, preserving the same
      // prefix and failed invocation's state; this is not a successful first hop.
      install(candidate);
      assert.equal(installed(), hop.sourceVersion);
      assert.deepEqual(json(path.join(root, "dist/build-info.json")), artifactBuildInfo(candidate));
      assert.notEqual(hash(path.join(root, "dist/build-info.json")), beforeBuild);
      assert.equal(
        json(path.join(root, "node_modules/@openclaw/fs-safe/package.json")).version,
        "0.10.0",
      );
      const result = runUpdate();
      assert.equal(result.status, 0, "owner-assisted candidate update failed");
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, "ok");
      assert.equal(installed(), hop.targetVersion);
      assert.equal(report.after?.version, hop.targetVersion);
      assert.deepEqual(json(path.join(root, "dist/build-info.json")), artifactBuildInfo(target));
      assert.equal(json(env.OPENCLAW_CONFIG_PATH).gateway.mode, "local");
      const afterStateIdentity = fs.statSync(stateDatabase);
      assert.equal(afterStateIdentity.dev, stateIdentity.dev);
      assert.equal(afterStateIdentity.ino, stateIdentity.ino);
      emit({
        passed: true,
        case: "owner-assisted bootstrap updates with preserved state",
        sourceSha: manifest.sourceSha,
        candidateSha256: manifest.files["openclaw-candidate.tgz"].sha256,
        firstHopSha256: manifest.files["openclaw-first-hop.tgz"].sha256,
        afterVersion: report.after.version,
        defaultRcServiceSupport: "not tested",
      });
      return;
    }
    install(candidate);
    assert.equal(installed(), hop.sourceVersion);
    const fsSafe = json(path.join(root, "node_modules/@openclaw/fs-safe/package.json"));
    assert.equal(fsSafe.version, "0.10.0");
    emit({
      fsSafe: fsSafe.version,
      npm: success("/usr/local/bin/npm", ["--version"], asUser),
      sourceSha: manifest.sourceSha,
    });
    const tree = (dir) =>
      fs
        .readdirSync(dir)
        .toSorted()
        .map((name) => {
          const file = path.join(dir, name);
          return {
            name,
            entry: entry(file),
            children: fs.lstatSync(file).isDirectory() ? tree(file) : undefined,
          };
        });
    let sequence = 0;
    const cli = (
      label,
      {
        preview = true,
        reason,
        packageRoot = root,
        npmPrefix = prefix,
        stateUnchanged = false,
        statePath,
      } = {},
    ) => {
      const state = statePath ?? path.join(task, `state-${sequence++}`);
      ownedDirectory(state);
      const env = {
        ...userEnv,
        npm_config_prefix: npmPrefix,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      };
      if (!preview && !fs.existsSync(path.join(state, "state/openclaw.sqlite"))) {
        // Canonical initialization gives the staged install an existing run ledger.
        success(
          process.execPath,
          [path.join(packageRoot, "openclaw.mjs"), "config", "set", "gateway.mode", "local"],
          { ...asUser, env, timeout: 120_000 },
        );
        assert(fs.statSync(path.join(state, "state/openclaw.sqlite")).isFile());
      }
      const beforeState = tree(state);
      const beforePackage = packageSnapshot(packageRoot);
      const started = Date.now();
      const result = command(
        process.execPath,
        [
          path.join(packageRoot, "openclaw.mjs"),
          "update",
          ...(preview ? ["--dry-run"] : []),
          "--tag",
          target,
          "--yes",
          "--no-restart",
          "--json",
        ],
        {
          ...asUser,
          timeout: preview ? 120_000 : 480_000,
          env,
        },
      );
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      const report = JSON.parse(result.stdout);
      if (reason) {
        assert.equal(result.status, 1, `${label}: expected typed refusal`);
        assert.equal(report.status, "error", label);
        assert.equal(report.reason, reason, label);
        assert.deepEqual(
          packageSnapshot(packageRoot),
          beforePackage,
          `${label}: package activation occurred`,
        );
        if (stateUnchanged) {
          assert.deepEqual(tree(state), beforeState, `${label}: root refusal changed state`);
        }
      } else {
        assert.equal(result.status, 0, `${label}: unexpected refusal`);
        if (preview) {
          assert.equal(report.dryRun, true);
          assert.equal(report.mode, "npm");
          assert.equal(report.restart, false);
          assert.equal(report.installKind, "package");
          assert(report.actions.some((action) => action.includes("global package manager update")));
          assert.deepEqual(packageSnapshot(packageRoot), beforePackage);
        } else {
          assert.equal(report.status, "ok");
          assert.equal(installed(), hop.targetVersion);
          assert.equal(report.after?.version, hop.targetVersion);
        }
      }
      emit({
        case: label,
        elapsedMs: Date.now() - started,
        reason: report.reason ?? null,
        sourceSha: manifest.sourceSha,
      });
      return report;
    };
    const withRegistration = (label, file, action) => {
      const name = `openclaw-proof-${process.pid}-${label}`;
      const metadata = path.join(task, `${label}.manifest`);
      const before = entry(file);
      fs.writeFileSync(
        metadata,
        JSON.stringify({
          name,
          version: "1",
          origin: "misc/openclaw-proof",
          comment: "Disposable OpenClaw ownership fixture",
          desc: "No scripts or dependencies; registration only.",
          maintainer: "fixture@example.invalid",
          www: "https://github.com/openclaw/openclaw",
          prefix: task,
          abi: pkg(["config", "ABI"]),
          files: { [file]: "" },
        }),
      );
      pkg(["register", "-M", metadata]);
      registered.add(name);
      const rows = pkg(["query", "%Fp", name]);
      assert.equal(rows, file);
      try {
        action();
        assert.equal(pkg(["query", "%Fp", name]), rows, `${label}: package ownership changed`);
        assert.deepEqual(entry(file), before, `${label}: owned entry changed`);
      } finally {
        pkg(["unregister", "-y", name]);
        registered.delete(name);
      }
    };

    cli("unprivileged ordinary npm preview");
    withRegistration("custom-root", path.join(root, "package.json"), () =>
      cli("pkg-owned custom-prefix root", { reason: "pkg-owned-install", stateUnchanged: true }),
    );

    // Preserve the lexical invoking root, including the conventional pkg prefix.
    const defaultRoot = "/usr/local/lib/node_modules/openclaw";
    assert(!fs.existsSync(defaultRoot), "disposable VM already contains OpenClaw");
    fs.renameSync(root, defaultRoot);
    restoreLayout = () => fs.renameSync(defaultRoot, root);
    withRegistration("default-root", path.join(defaultRoot, "package.json"), () =>
      cli("pkg-owned default-prefix root", {
        packageRoot: defaultRoot,
        npmPrefix: "/usr/local",
        reason: "pkg-owned-install",
        stateUnchanged: true,
      }),
    );
    restoreLayout();
    restoreLayout = undefined;

    const parentAlias = path.join(task, "registered alias");
    fs.symlinkSync(path.dirname(root), parentAlias);
    withRegistration("parent-alias", path.join(parentAlias, "openclaw/package.json"), () =>
      cli("registered parent alias owns actual root", {
        reason: "pkg-owned-install",
        stateUnchanged: true,
      }),
    );

    const relocated = path.join(task, "relocated-package");
    fs.renameSync(root, relocated);
    fs.symlinkSync(relocated, root);
    restoreLayout = () => {
      fs.unlinkSync(root);
      fs.renameSync(relocated, root);
    };
    withRegistration("root-link", root, () =>
      cli("pkg-owned root symlink entry", { reason: "pkg-owned-install", stateUnchanged: true }),
    );
    restoreLayout();
    restoreLayout = undefined;

    const unrelatedLink = path.join(task, "unrelated-registered-link");
    fs.symlinkSync(root, unrelatedLink);
    withRegistration("unrelated-link", unrelatedLink, () =>
      cli("unrelated owned symlink does not own its target"),
    );

    lockedParent = path.join(task, "inaccessible-package-parent");
    fs.mkdirSync(lockedParent);
    const inaccessible = path.join(lockedParent, "owned-file");
    fs.writeFileSync(inaccessible, "unrelated package file\n");
    withRegistration("inaccessible", inaccessible, () => {
      fs.chmodSync(lockedParent, 0o700);
      const access = command("/bin/test", ["-r", inaccessible], asUser);
      assert.equal(access.status, 1, "fixture user must not read the registered parent");
      cli("inaccessible registered parent remains unknown", {
        reason: "pkg-ownership-unavailable",
        stateUnchanged: true,
      });
      fs.chmodSync(lockedParent, 0o755);
    });
    lockedParent = undefined;

    const beforeLauncher = entry(launcher);
    const retryState = path.join(task, "launcher-retry-state");
    withRegistration("launcher", launcher, () => {
      const report = cli("changed-version staged update preserves owned launcher", {
        preview: false,
        reason: "pkg-owned-install",
        statePath: retryState,
      });
      // A thrown pkg admission becomes a typed final refusal, not a returned swap
      // step. The existing ledger retains the completed native staging command.
      assert(
        report.run.steps.some(
          (step) => step.step === "global update" && step.status === "completed",
        ),
        "must finish the real staged npm install before launcher refusal",
      );
      assert.deepEqual(entry(launcher), beforeLauncher);
      assert.equal(installed(), hop.sourceVersion);
    });
    // The same artifact now must actually activate; no same-version/no-op proof.
    cli("unowned changed-version staged update retries the same state", {
      preview: false,
      statePath: retryState,
    });
    assert.deepEqual(pkg(["query", "-a", "%n-%v"]).split("\n").toSorted(), packages.toSorted());
    emit({
      passed: true,
      sourceSha: manifest.sourceSha,
      candidateSha256: manifest.files["openclaw-candidate.tgz"].sha256,
      firstHopSha256: manifest.files["openclaw-first-hop.tgz"].sha256,
      defaultRcServiceSupport: "not tested",
    });
  } finally {
    if (lockedParent) {
      fs.chmodSync(lockedParent, 0o755);
    }
    for (const name of registered) {
      pkg(["unregister", "-y", name]);
    }
    restoreLayout?.();
    if (userCreated) {
      success("/usr/sbin/pw", ["userdel", "-n", user]);
    }
    fs.rmSync(task, { recursive: true, force: true });
  }
}

try {
  const [mode, rawDirectory, architecture] = process.argv.slice(2);
  const directory = rawDirectory ? path.resolve(rawDirectory) : undefined;
  if (mode === "stamp") {
    await stamp(directory);
  } else if (mode === "artifact") {
    await recordArtifact();
  } else if (mode === "verify-artifact") {
    await verifyArtifact(directory);
  } else if (mode === "native") {
    native(directory, architecture);
  } else if (mode === "published") {
    native(directory, architecture, true);
  } else if (mode === "shutdown") {
    await shutdown(directory);
  } else {
    throw new Error(`Unknown proof mode: ${mode}`);
  }
} catch (error) {
  console.error(error);
  console.error("[freebsd-pkg-update-proof] FAILED (exit 1)");
  process.exitCode = 1;
}
