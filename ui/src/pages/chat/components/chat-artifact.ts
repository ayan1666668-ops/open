export type ArtifactKind =
  | "code"
  | "text"
  | "markdown"
  | "html"
  | "pdf"
  | "docx"
  | "spreadsheet"
  | "presentation"
  | "unsupported";

const CODE_EXTENSIONS = new Set([
  "c", "cc", "cpp", "css", "go", "h", "hpp", "java", "js", "jsx", "json", "mjs",
  "py", "rb", "rs", "sh", "sql", "toml", "ts", "tsx", "xml", "yaml", "yml", "zsh",
]);
const CODE_MIMES = new Set([
  "application/javascript", "application/json", "application/ld+json", "application/sql",
  "application/typescript", "application/xml", "application/x-httpd-php", "application/x-javascript",
  "application/x-sh", "application/x-yaml", "text/css", "text/csv", "text/javascript",
  "text/typescript", "text/x-python", "text/x-shellscript", "text/xml", "text/yaml",
]);
const SPREADSHEET_MIMES = new Set([
  "application/vnd.ms-excel.sheet.macroenabled.12", "application/vnd.ms-excel.template.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
]);
const PRESENTATION_MIMES = new Set([
  "application/vnd.ms-powerpoint.presentation.macroenabled.12", "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
  "application/vnd.ms-powerpoint.template.macroenabled.12", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow", "application/vnd.openxmlformats-officedocument.presentationml.template",
]);

export function artifactExtension(filename: string): string {
  const base = filename.toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

export function classifyArtifact(filename: string, rawMimeType?: string | null): ArtifactKind {
  const ext = artifactExtension(filename);
  const mime = (rawMimeType ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (ext === "html" || ext === "htm" || mime === "text/html") return "html";
  if (ext === "md" || ext === "markdown" || mime === "text/markdown") return "markdown";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (ext === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (["xlsx", "xlsm", "xltx", "xltm"].includes(ext) || SPREADSHEET_MIMES.has(mime)) return "spreadsheet";
  if (["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"].includes(ext) || PRESENTATION_MIMES.has(mime)) return "presentation";
  if (CODE_EXTENSIONS.has(ext) || CODE_MIMES.has(mime)) return "code";
  if (ext === "txt" || ext === "log" || mime === "text/plain" || mime.startsWith("text/")) return "text";
  return "unsupported";
}

export function artifactPreviewLimit(kind: ArtifactKind): number | undefined {
  if (kind === "pdf") return 64 * 1024 * 1024;
  if (kind === "spreadsheet" || kind === "presentation") return 24 * 1024 * 1024;
  if (["code", "text", "markdown", "html", "docx"].includes(kind)) return 2 * 1024 * 1024;
  return undefined;
}

export function artifactLabel(kind: ArtifactKind): string {
  return ({ code: "Code", text: "Text", markdown: "Markdown", html: "Web page", pdf: "PDF", docx: "Word document", spreadsheet: "Spreadsheet", presentation: "Slide text outline", unsupported: "File" })[kind];
}
