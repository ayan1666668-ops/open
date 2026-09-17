export type ParsedCommandSegment = {
  argv: string[];
};

export type HeavyCommandClassification = {
  heavy: boolean;
  reason?: string;
  segments: ParsedCommandSegment[];
};

const SEGMENT_OPERATORS = new Set([";", "&&", "||", "|", "&", "\n"]);
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
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

function classifyArgv(argvInput: readonly string[], depth = 0): string | undefined {
  if (depth > 3) {
    return "nested shell wrapper";
  }
  let argv = stripEnvironmentPrefix(argvInput);
  if (argv.length === 0) {
    return undefined;
  }
  let bin = executableBase(argv[0]);
  if (bin === "env") {
    const rest = argv.slice(1).filter((token) => !token.startsWith("-") && !isAssignment(token));
    return classifyArgv(rest, depth + 1);
  }
  if (SHELL_WRAPPERS.has(bin)) {
    const cIndex = argv.findIndex((token) => token === "-c" || token === "/c");
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
