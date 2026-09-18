import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasUnjoinedWork, runManagedCommand } from "../../lib/managed-child-process.mts";

// These checks catch accidental local invocation. Isolation is supplied by the
// disposable GitHub-hosted macOS job, not by environment variables or this script.
assert.equal(process.platform, "darwin", "disposable macOS CI only");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.env.RUNNER_OS, "macOS");
assert.equal(process.env.GITHUB_REPOSITORY, "openclaw/openclaw");
assert.equal(process.env.GITHUB_JOB, "macos-swift");
assert.equal(process.env.GITHUB_EVENT_NAME, "pull_request");
assert.equal(process.env.OWNERSHIP_PROOF_PHASE, "tests");
for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
  assert(/^[1-9]\d*$/.test(process.env[key] ?? ""), key);
}
for (const key of ["GITHUB_SHA", "OWNERSHIP_WORKFLOW_SHA", "OWNERSHIP_PR_HEAD"]) {
  assert(/^[0-9a-f]{40}$/.test(process.env[key] ?? ""), key);
}
assert.match(
  process.env.GITHUB_WORKFLOW_REF ?? "",
  /^openclaw\/openclaw\/\.github\/workflows\/ci\.yml@refs\/pull\/\d+\/merge$/,
);

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = fs.realpathSync(path.resolve(here, "../../.."));
assert.equal(fs.realpathSync(process.env.GITHUB_WORKSPACE), repo);
const runnerTemp = fs.realpathSync(process.env.RUNNER_TEMP);
const namespace = path.join(
  runnerTemp,
  `openclaw-audio-ownership-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
);
assert(!fs.existsSync(namespace), "never overwrite a previous proof attempt");
const freeBytes = () => {
  const disk = fs.statfsSync(runnerTemp);
  return disk.bavail * disk.bsize;
};
assert(freeBytes() > 3.5 * 1024 ** 3, "disk launch floor");
fs.mkdirSync(namespace, { mode: 0o700 });
const evidence = path.join(namespace, "evidence");
const build = path.join(namespace, "build");
for (const directory of [evidence, build, ...["home", "tmp", "cache"].map((p) => path.join(build, p))]) {
  fs.mkdirSync(directory, { mode: 0o700 });
}

const limit = 64 * 1024 ** 2;
const reserve = 1024 ** 2;
const maxFiles = 96;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitBlob = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
let retainedBytes = 0;
let retainedFiles = 0;
let outputBytes = 0;
let allJoined = true;
let minimumDisk = freeBytes();
const commands = [];
const cleanText = (value) =>
  String(value).replaceAll(namespace, "$PROOF").replaceAll(repo, "$CHECKOUT");
const childEnv = {
  PATH: process.env.PATH,
  HOME: path.join(build, "home"),
  CFFIXED_USER_HOME: path.join(build, "home"),
  TMPDIR: path.join(build, "tmp"),
  XDG_CACHE_HOME: path.join(build, "cache"),
  CLANG_MODULE_CACHE_PATH: path.join(build, "cache", "clang"),
  SWIFT_MODULECACHE_PATH: path.join(build, "cache", "swift"),
  LANG: "C",
  TZ: "UTC",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}),
};
function openEvidence(name) {
  assert(/^[a-zA-Z0-9_.-]+$/.test(name));
  assert(retainedFiles < maxFiles, "artifact file limit");
  const fd = fs.openSync(path.join(evidence, name), "wx", 0o600);
  retainedFiles += 1;
  return fd;
}
function retain(name, bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  assert(retainedBytes + value.length <= limit, "artifact byte limit");
  const fd = openEvidence(name);
  try {
    fs.writeFileSync(fd, value);
    retainedBytes += value.length;
  } finally {
    fs.closeSync(fd);
  }
}
const retainJson = (name, value) => retain(name, JSON.stringify(value, null, 2) + "\n");

async function command(name, bin, args, { timeoutMs = 20000, expected = 0, cwd = build } = {}) {
  minimumDisk = Math.min(minimumDisk, freeBytes());
  assert(minimumDisk >= 2 * 1024 ** 3, "disk stop floor");
  const controller = new AbortController();
  const stdout = [];
  const fds = [openEvidence(`${name}.stdout.log`), openEvidence(`${name}.stderr.log`)];
  let code = null;
  let error = null;
  let child;
  let abortReason = null;
  let signal = null;
  let monitor;
  const started = new Date().toISOString();
  const startedMs = performance.now();
  const abort = (reason) => {
    abortReason ??= reason;
    controller.abort();
  };
  try {
    code = await runManagedCommand({
      bin,
      args,
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs,
      timeoutKillGraceMs: 5000,
      abortKillGraceMs: 5000,
      timeoutForceKillOnLeaderExit: true,
      requireProcessTreeExit: true,
      signal: controller.signal,
      onSignal: (received) => {
        signal ??= received;
      },
      onReady: (owned) => {
        child = owned;
        for (const [index, stream] of [child.stdout, child.stderr].entries()) {
          stream.on("data", (bytes) => {
            outputBytes += bytes.length;
            if (retainedBytes + bytes.length > limit - reserve) {
              abort("aggregate-output-limit");
              return;
            }
            try {
              fs.writeSync(fds[index], bytes);
              retainedBytes += bytes.length;
              if (index === 0) stdout.push(bytes);
            } catch {
              abort("artifact-write-failed");
            }
          });
        }
        monitor = setInterval(() => {
          try {
            minimumDisk = Math.min(minimumDisk, freeBytes());
            if (minimumDisk < 2 * 1024 ** 3) abort("disk-stop");
          } catch {
            abort("disk-observation-failed");
          }
        }, 1000);
      },
    });
  } catch (failure) {
    error = {
      message: cleanText(failure.message),
      code: failure.code ?? null,
      unjoined: hasUnjoinedWork(failure),
    };
  } finally {
    clearInterval(monitor);
    for (const fd of fds) fs.closeSync(fd);
  }
  const terminal = {
    name,
    bin,
    args: args.map(cleanText),
    started,
    finished: new Date().toISOString(),
    elapsedMs: Math.ceil(performance.now() - startedMs),
    timeoutMs,
    code,
    childExitCode: child?.exitCode ?? null,
    signal: signal ?? child?.signalCode ?? null,
    abortReason,
    error,
    cleanupJoined: !error?.unjoined,
  };
  allJoined &&= terminal.cleanupJoined;
  commands.push(terminal);
  // Preserve actual terminality before interpreting an expected baseline failure.
  retainJson(`${name}.result.json`, terminal);
  console.log(JSON.stringify({ command: name, code, cleanupJoined: terminal.cleanupJoined }));
  assert(terminal.cleanupJoined && !error && !abortReason && !terminal.signal, `${name} incomplete`);
  assert.equal(code, expected, `${name} exit`);
  return Buffer.concat(stdout);
}

const symbols = [
  "_AudioObjectGetPropertyData",
  "_AudioObjectGetPropertyDataSize",
  "_AudioObjectAddPropertyListenerBlock",
  "_AudioObjectRemovePropertyListenerBlock",
  "_AudioUnitSetProperty",
].sort();
function verifyLinkMap(bytes) {
  const lines = bytes.toString("utf8").split("\n");
  const objects = lines.flatMap((line) => {
    const match = /^\[\s*(\d+)\]\s+(.+)$/.exec(line);
    return match && path.basename(match[2]) === "BoundaryStub.o" ? [match[1]] : [];
  });
  assert.equal(objects.length, 1, "exactly one stub object in link map");
  for (const symbol of symbols) {
    const owners = lines.flatMap((line) => {
      const match = /^\S+\s+\S+\s+\[\s*(\d+)\]\s+(\S+)$/.exec(line.trim());
      return match?.[2] === symbol ? [match[1]] : [];
    });
    assert.deepEqual(owners, objects, `${symbol} must be defined by BoundaryStub.o`);
  }
}
function verifyRows(bytes, baseline) {
  const rows = bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 11, "ten observations and one summary");
  const summary = rows.pop();
  assert.deepEqual(summary, {
    allFixtureAllocationsJoined: true,
    cases: 10,
    kind: "summary",
    ownershipFailures: baseline ? 2 : 0,
  });
  const ids = [];
  for (const selector of ["deviceUID", "deviceName"]) {
    for (const [kind, mode] of [
      ["self-control", "retained"],
      ["self-control", "unretained"],
      ["production-getter", "owned"],
      ["production-getter", "error"],
      ["production-getter", "nil"],
    ]) {
      const row = rows[ids.length];
      assert.deepEqual([row.selector, row.kind, row.mode], [selector, kind, mode]);
      ids.push(`${selector}/${kind}/${mode}`);
      for (const key of [
        "allocations", "reallocations", "deallocations", "liveBlocks", "liveBytes",
        "sourceObjectLive", "defaultCalls", "uidCalls", "nameCalls",
      ]) assert(Number.isSafeInteger(row[key]) && row[key] >= 0, key);
      const production = kind === "production-getter";
      assert.deepEqual(
        [row.defaultCalls, row.uidCalls, row.nameCalls],
        production ? [1, 1, selector === "deviceName" ? 1 : 0] : [0, 0, 0],
      );
      const outstanding = mode === "unretained" || (production && mode === "owned" && baseline);
      assert.equal(row.ownershipPass, !outstanding);
      if (outstanding) {
        assert(row.liveBlocks > 0 && row.liveBytes > 0 && row.sourceObjectLive === 1);
      } else {
        assert.deepEqual([row.liveBlocks, row.liveBytes, row.sourceObjectLive], [0, 0, 0]);
      }
      if (mode === "error" || mode === "nil") {
        assert.deepEqual([row.allocations, row.reallocations, row.deallocations], [0, 0, 0]);
      } else {
        assert(row.allocations > 0, "the allocator must witness the object");
      }
    }
  }
  return { ids, summary };
}

const result = {
  passed: false,
  started: new Date().toISOString(),
  runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  workflowRef: process.env.GITHUB_WORKFLOW_REF,
  workflowSha: process.env.OWNERSHIP_WORKFLOW_SHA,
  githubSha: process.env.GITHUB_SHA,
  prHead: process.env.OWNERSHIP_PR_HEAD,
  limits: { compileMs: 120000, executionMs: 20000, drainMs: 5000, bytes: limit, files: maxFiles },
  commands,
};
const ownerPath = path.join(repo, "apps/macos/Sources/OpenClaw/AudioInputDeviceObserver.swift");
const workflowPath = path.join(repo, ".github/workflows/ci.yml");
const owner = fs.readFileSync(ownerPath);
const workflow = fs.readFileSync(workflowPath);
try {
  const source = fs.readFileSync(path.join(here, "AudioInputDeviceObserver.original.swift"));
  assert.equal(gitBlob(source), "486655f758e3401e77fbd4632131401cc6badb70");
  assert.equal(sha256(source), "fd4f30f06bc1487879a09359a3c6c49ca1e728619b069a7addffc53ea602bc41");
  assert.equal(sha256(owner), "c0e32e40a235aedcfae21d453094a81d608c748aeb021cf243d0f59bb59593d9");
  const git = (name, args) => command(name, "/usr/bin/git", ["-C", repo, ...args]);
  result.checkout = (await git("checkout-head", ["rev-parse", "HEAD"])).toString().trim();
  assert.match(result.checkout, /^[0-9a-f]{40}$/);
  const committed = await git("committed-owner", [
    "show", `${result.checkout}:apps/macos/Sources/OpenClaw/AudioInputDeviceObserver.swift`,
  ]);
  assert(committed.equals(owner), "actual candidate must match the tested commit");
  const definition = await git("workflow-definition", [
    "show", `${result.workflowSha}:.github/workflows/ci.yml`,
  ]);
  assert(definition.equals(workflow), "executing workflow definition must contain this exact step");
  assert(definition.includes(Buffer.from("run: node scripts/ci/audio-input-ownership/run.mjs")));
  result.workflowBlob = gitBlob(definition);
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  assert.equal(event.pull_request?.head?.sha, result.prHead);
  assert.equal(event.pull_request?.head?.repo?.full_name, "openclaw/openclaw");
  result.pr = event.number;
  result.source = {
    baseline: { blob: gitBlob(source), sha256: sha256(source), bytes: source.length },
    candidate: { blob: gitBlob(owner), sha256: sha256(owner), bytes: owner.length },
    inputs: Object.fromEntries(
      ["BoundaryStub.c", "BoundaryStub.h", "Driver.swift", "verify-bindings.mjs", "run.mjs"].map(
        (name) => [name, sha256(fs.readFileSync(path.join(here, name)))],
      ),
    ),
  };
  retain("baseline.swift", source);
  retain("candidate.swift", owner);

  const tool = async (name, args) => {
    const invocation = (await command(name, "/usr/bin/xcrun", args)).toString().trim();
    assert(path.isAbsolute(invocation), `${name} must be absolute`);
    const canonical = fs.realpathSync(invocation);
    for (const resolved of [invocation, canonical]) {
      assert(!resolved.startsWith(repo + "/") && !resolved.startsWith(namespace + "/"));
    }
    return { invocation, canonical };
  };
  const sdkPath = await tool("sdk-path", ["--sdk", "macosx", "--show-sdk-path"]);
  const clangPath = await tool("clang-path", ["--sdk", "macosx", "--find", "clang"]);
  const swiftcPath = await tool("swiftc-path", ["--sdk", "macosx", "--find", "swiftc"]);
  const sdk = sdkPath.canonical;
  // Preserve the driver name: resolving swiftc can select swift-frontend instead.
  const clang = clangPath.invocation;
  const swiftc = swiftcPath.invocation;
  result.tools = {
    sdk, clang, swiftc,
    canonical: { sdk: sdkPath.canonical, clang: clangPath.canonical, swiftc: swiftcPath.canonical },
    node: process.version,
  };
  await command("clang-version", clang, ["--version"]);
  await command("swift-version", swiftc, ["--version"]);
  const header = fs.readFileSync(path.join(
    sdk, "System/Library/Frameworks/CoreAudio.framework/Headers/AudioHardwareBase.h",
  ));
  const clauses = {};
  for (const selector of ["kAudioObjectPropertyName", "kAudioDevicePropertyDeviceUID"]) {
    const match = new RegExp(`@constant\\s+${selector}\\b([\\s\\S]*?)(?=@constant|$)`).exec(header.toString());
    assert(match, `missing SDK clause ${selector}`);
    const clause = match[1].replace(/\s+/g, " ").trim();
    assert(clause.includes("The caller is responsible for releasing the returned CFObject."));
    clauses[selector] = clause;
  }
  result.sdkHeader = { sha256: sha256(header), clauses };
  retainJson("sdk-ownership.json", result.sdkHeader);

  const stub = path.join(build, "BoundaryStub.o");
  await command("compile-stub", clang, [
    "-std=c11", "-fblocks", "-Wall", "-Wextra", "-Werror", "-isysroot", sdk,
    "-I", here, "-c", path.join(here, "BoundaryStub.c"), "-o", stub,
  ], { timeoutMs: 120000 });
  await command("stub-defined", "/usr/bin/nm", ["-gjU", stub]);
  result.phases = {};
  for (const phase of ["baseline", "candidate"]) {
    const object = path.join(build, `${phase}.o`);
    const binary = path.join(build, `${phase}-proof`);
    const linkMap = path.join(build, `${phase}.map`);
    await command(`${phase}-compile`, swiftc, [
      "-sdk", sdk, "-Onone", "-whole-module-optimization", "-parse-as-library",
      "-emit-object", "-module-name", "Rank124Ownership",
      "-import-objc-header", path.join(here, "BoundaryStub.h"),
      path.join(evidence, `${phase}.swift`), path.join(here, "Driver.swift"), "-o", object,
    ], { timeoutMs: 120000 });
    await command(`${phase}-link`, swiftc, [
      "-sdk", sdk, object, stub, ...["Foundation", "CoreFoundation", "CoreAudio",
        "AudioToolbox", "AVFoundation", "OSLog"].flatMap((name) => ["-framework", name]),
      "-Xlinker", "-export_dynamic", "-Xlinker", "-map", "-Xlinker", linkMap, "-o", binary,
    ], { timeoutMs: 120000 });
    await command(`${phase}-owner-undefined`, "/usr/bin/nm", ["-uj", object]);
    await command(`${phase}-defined`, "/usr/bin/nm", ["-gjU", binary]);
    await command(`${phase}-undefined`, "/usr/bin/nm", ["-uj", binary]);
    await command(`${phase}-symbols`, process.execPath, [
      path.join(here, "verify-bindings.mjs"),
      path.join(evidence, `${phase}-owner-undefined.stdout.log`),
      path.join(evidence, "stub-defined.stdout.log"),
      path.join(evidence, `${phase}-defined.stdout.log`),
      path.join(evidence, `${phase}-undefined.stdout.log`),
    ]);
    assert(fs.statSync(linkMap).size <= 4 * 1024 ** 2, "link map bound");
    const mapBytes = fs.readFileSync(linkMap);
    verifyLinkMap(mapBytes);
    retain(`${phase}.map`, mapBytes);
    const hashes = Object.fromEntries(
      [["ownerObject", object], ["stubObject", stub], ["binary", binary]].map(
        ([name, filename]) => [name, sha256(fs.readFileSync(filename))],
      ),
    );
    const observations = await command(`${phase}-execute`, binary, [], {
      expected: phase === "baseline" ? 1 : 0,
    });
    result.phases[phase] = { ...verifyRows(observations, phase === "baseline"), hashes };
  }
  assert.deepEqual(result.phases.baseline.ids, result.phases.candidate.ids);
  assert(fs.readFileSync(ownerPath).equals(owner), "candidate source changed during proof");
  assert(fs.readFileSync(workflowPath).equals(workflow), "workflow source changed during proof");
  for (const [name, digest] of Object.entries(result.source.inputs)) {
    assert.equal(sha256(fs.readFileSync(path.join(here, name))), digest, name);
  }
  result.passed = true;
} catch (error) {
  result.failure = cleanText(error.message);
  process.exitCode = 1;
} finally {
  result.cleanupJoined = allJoined;
  result.finished = new Date().toISOString();
  result.minimumDiskBytes = minimumDisk;
  result.observedOutputBytes = outputBytes;
  if (allJoined) {
    try {
      fs.rmSync(build, { recursive: true });
      result.ownedBuildRemoved = true;
    } catch (error) {
      result.ownedBuildRemoved = false;
      result.passed = false;
      result.cleanupFailure = cleanText(error.message);
      process.exitCode = 1;
    }
  } else {
    result.ownedBuildRemoved = false;
    result.passed = false;
    process.exitCode = 1;
  }
  retainJson("result.json", result);
  const artifacts = fs.readdirSync(evidence).sort().map((name) => {
    const file = path.join(evidence, name);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    return { name, bytes: stat.size, sha256: sha256(fs.readFileSync(file)) };
  });
  retainJson("manifest.json", { files: artifacts, result: "result.json" });
  assert(retainedFiles <= maxFiles && retainedBytes <= limit);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `artifact-path=${evidence}\n`);
  console.log(JSON.stringify({
    passed: result.passed, cleanupJoined: allJoined, retainedFiles, retainedBytes,
    baselineFailures: result.phases?.baseline?.summary.ownershipFailures ?? null,
    candidateFailures: result.phases?.candidate?.summary.ownershipFailures ?? null,
  }));
}
