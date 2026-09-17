export type ParsedCommandSegment = {
  argv: string[];
};

export type HeavyCommandClassification = {
  heavy: boolean;
  reason?: string;
  segments: ParsedCommandSegment[];
};

export type LocalCommandAssessment = {
  allowed: boolean;
  reason?: string;
  segments: ParsedCommandSegment[];
};

const SEGMENT_OPERATORS = new Set([";", "&&", "||", "|", "&", "\n"]);
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const WRAPPER_BINS = new Set(["command", "nice", "nohup", "sudo", "timeout"]);
const HEAVY_PACKAGE_MANAGER_SUBCOMMANDS = new Set([
  "add",
  "build",
  "ci",
  "compile",
  "dlx",
  "exec",
  "install",
  "i",
  "link",
  "rebuild",
  "remove",
  "run",
  "test",
  "t",
  "update",
  "upgrade",
]);
const HEAVY_BINS = new Set([
  "cargo",
  "cmake",
  "docker",
  "docker-compose",
  "gradle",
  "make",
  "mvn",
  "pytest",
  "tox",
  "tsc",
  "vite",
  "vitest",
  "webpack",
  "xcodebuild",
]);
const HEAVY_GO_SUBCOMMANDS = new Set(["build", "get", "install", "run", "test"]);
const HEAVY_PIP_SUBCOMMANDS = new Set(["install", "uninstall", "download", "wheel"]);
const HEAVY_SWIFT_SUBCOMMANDS = new Set(["build", "test", "run", "package"]);
const COREPACK_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const SAFE_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);
const SAFE_READ_BINS = new Set([
  "cat",
  "find",
  "grep",
  "head",
  "less",
  "ls",
  "pwd",
  "sed",
  "tail",
  "test",
  "true",
  "wc",
  "which",
]);
const SAFE_VERSION_BINS = new Set(["node", "python", "python3", "npm", "pnpm", "yarn", "bun", "openclaw", "gh", "railway"]);

function executableBase(raw: string | undefined): string {
  if (!raw) {
    return "";
  }
  const withoutPath = raw.split(/[\\/]/).pop() ?? raw;
  return withoutPath.replace(/\.(?:cmd|exe|bat)$/i, "").toLowerCase();
}

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function hasDynamicShellSyntax(command: string): boolean {
  return /[`]|\$\(|\$\{|<\(|>\(|\$\[|\$'/u.test(command);
}

function tokenize(command: string): Array<string | "\n"> | null {
  const tokens: Array<string | "\n"> = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" && i + 1 < command.length) {
        i += 1;
        current += command[i]!;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      i += 1;
      current += command[i]!;
      continue;
    }
    if (ch === "#" && !current) {
      while (i < command.length && command[i] !== "\n") {
        i += 1;
      }
      tokens.push("\n");
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      if (ch === "\n") {
        tokens.push("\n");
      }
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      tokens.push(two);
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      tokens.push(ch);
      continue;
    }
    current += ch;
  }
  if (quote) {
    return null;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

export function parseCommandSegments(command: string): ParsedCommandSegment[] {
  const tokens = tokenize(command);
  if (!tokens) {
    return [];
  }
  const segments: ParsedCommandSegment[] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (SEGMENT_OPERATORS.has(token)) {
      if (current.length > 0) {
        segments.push({ argv: current });
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    segments.push({ argv: current });
  }
  return segments;
}

function stripEnvironmentPrefix(argv: readonly string[]): string[] {
  let index = 0;
  while (index < argv.length && isAssignment(argv[index]!)) {
    index += 1;
  }
  return argv.slice(index);
}

function firstNonOption(tokens: readonly string[]): string | undefined {
  return tokens.find((token) => !token.startsWith("-"));
}

function classifyArgv(argvInput: readonly string[], depth = 0): string | undefined {
  if (depth > 3) {
    return "nested shell wrapper";
  }
  const argv = stripEnvironmentPrefix(argvInput);
  if (argv.length === 0) {
    return undefined;
  }
  const bin = executableBase(argv[0]);
  if (bin === "env") {
    let commandIndex = 1;
    while (commandIndex < argv.length) {
      const token = argv[commandIndex]!;
      if (token === "--") {
        commandIndex += 1;
        break;
      }
      if (isAssignment(token) || token.startsWith("-")) {
        commandIndex += 1;
        continue;
      }
      break;
    }
    return classifyArgv(argv.slice(commandIndex), depth + 1);
  }
  if (SHELL_WRAPPERS.has(bin)) {
    const cIndex = argv.findIndex(
      (token) => token === "/c" || token === "-c" || (/^-[A-Za-z]*c[A-Za-z]*$/.test(token) && token !== "--"),
    );
    const script = cIndex >= 0 ? argv[cIndex + 1] : undefined;
    if (script) {
      const nested = classifyHeavyCommand(script);
      return nested.heavy ? nested.reason ?? "nested shell heavy command" : undefined;
    }
    return undefined;
  }
  if (bin === "corepack") {
    const manager = argv.slice(1).find((token) => !token.startsWith("-"));
    if (COREPACK_PACKAGE_MANAGERS.has(executableBase(manager))) {
      return `corepack ${manager}`;
    }
    return undefined;
  }
  if (PACKAGE_MANAGERS.has(bin)) {
    const subcommand = argv.slice(1).find((token) => !token.startsWith("-"))?.toLowerCase();
    if (!subcommand || HEAVY_PACKAGE_MANAGER_SUBCOMMANDS.has(subcommand)) {
      return `${bin}${subcommand ? ` ${subcommand}` : ""}`;
    }
    return undefined;
  }
  if ((bin === "python" || bin === "python3") && argv[1] === "-m") {
    const module = argv[2]?.toLowerCase();
    const subcommand = argv[3]?.toLowerCase();
    if ((module === "pip" || module === "pip3") && HEAVY_PIP_SUBCOMMANDS.has(subcommand ?? "")) {
      return `${bin} -m ${module} ${subcommand}`;
    }
    if (module === "pytest") {
      return `${bin} -m pytest`;
    }
  }
  if ((bin === "pip" || bin === "pip3") && HEAVY_PIP_SUBCOMMANDS.has(argv[1]?.toLowerCase() ?? "")) {
    return `${bin} ${argv[1]}`;
  }
  if (bin === "go" && HEAVY_GO_SUBCOMMANDS.has(argv[1]?.toLowerCase() ?? "")) {
    return `go ${argv[1]}`;
  }
  if (bin === "swift" && HEAVY_SWIFT_SUBCOMMANDS.has(argv[1]?.toLowerCase() ?? "")) {
    return `swift ${argv[1]}`;
  }
  if (HEAVY_BINS.has(bin)) {
    return bin;
  }
  return undefined;
}

function isSafeVersionCommand(argv: readonly string[]): boolean {
  const bin = executableBase(argv[0]);
  return SAFE_VERSION_BINS.has(bin) && argv.length === 2 && ["--version", "-v", "version"].includes(argv[1] ?? "");
}

function gitSubcommand(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-C") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token.toLowerCase();
  }
  return undefined;
}

function unsafeFindArgs(argv: readonly string[]): string | undefined {
  return argv.find((token) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(token));
}

function assessArgvSafe(argvInput: readonly string[], depth = 0): string | undefined {
  if (depth > 3) {
    return "nested wrapper depth is not an approved local route";
  }
  const argv = stripEnvironmentPrefix(argvInput);
  if (argv.length === 0) {
    return undefined;
  }
  const bin = executableBase(argv[0]);
  if (WRAPPER_BINS.has(bin)) {
    return `${bin} wrapper is not an approved local route`;
  }
  if (bin === "env") {
    let commandIndex = 1;
    while (commandIndex < argv.length) {
      const token = argv[commandIndex]!;
      if (token === "--") {
        commandIndex += 1;
        break;
      }
      if (isAssignment(token) || token === "-i" || token === "-0" || token.startsWith("-u")) {
        commandIndex += 1;
        continue;
      }
      if (token.startsWith("-")) {
        return `env option ${token} is not an approved local route`;
      }
      break;
    }
    return assessArgvSafe(argv.slice(commandIndex), depth + 1);
  }
  if (SHELL_WRAPPERS.has(bin)) {
    const cIndex = argv.findIndex(
      (token) => token === "/c" || token === "-c" || (/^-[A-Za-z]*c[A-Za-z]*$/.test(token) && token !== "--"),
    );
    const script = cIndex >= 0 ? argv[cIndex + 1] : undefined;
    if (!script) {
      return `${bin} without an explicit safe script is not an approved local route`;
    }
    return assessLocalCommand(script, depth + 1).reason;
  }
  if (bin === "git") {
    const subcommand = gitSubcommand(argv);
    if (subcommand && SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
      return undefined;
    }
    return `git ${subcommand ?? "command"} is not an approved local read/maintenance route`;
  }
  if (bin === "find") {
    const unsafe = unsafeFindArgs(argv);
    return unsafe ? `find ${unsafe} is not an approved local read route` : undefined;
  }
  if (SAFE_READ_BINS.has(bin)) {
    return undefined;
  }
  if (isSafeVersionCommand(argv)) {
    return undefined;
  }
  const heavyReason = classifyArgv(argv);
  if (heavyReason) {
    return `${heavyReason} requires remote execution`;
  }
  return `${bin || firstNonOption(argv) || "command"} is not an approved local read/maintenance route`;
}

export function assessLocalCommand(command: string, depth = 0): LocalCommandAssessment {
  if (hasDynamicShellSyntax(command)) {
    return { allowed: false, reason: "dynamic shell substitution is not an approved local route", segments: [] };
  }
  const segments = parseCommandSegments(command);
  if (segments.length === 0 && command.trim()) {
    return { allowed: false, reason: "command could not be parsed safely", segments };
  }
  for (const segment of segments) {
    const reason = assessArgvSafe(segment.argv, depth);
    if (reason) {
      return { allowed: false, reason, segments };
    }
  }
  return { allowed: true, segments };
}

export function classifyHeavyCommand(command: string): HeavyCommandClassification {
  const segments = parseCommandSegments(command);
  for (const segment of segments) {
    const reason = classifyArgv(segment.argv);
    if (reason) {
      return { heavy: true, reason, segments };
    }
  }
  return { heavy: false, segments };
}
