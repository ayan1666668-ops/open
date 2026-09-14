import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from "fflate";
import DOMPurify from "dompurify";
import { icons } from "../../../components/icons.ts";
import { markdownBlocks } from "../../../components/markdown-blocks.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { artifactLabel, artifactPreviewLimit, classifyArtifact, type ArtifactKind } from "./chat-artifact.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

type OfficeSheet = { name: string; cells: Map<string, string> };
type OfficeSlide = { title: string; paragraphs: string[] };

function xmlText(value: string): string {
  const doc = new DOMParser().parseFromString(`<x>${value}</x>`, "application/xml");
  return doc.documentElement ? (doc.documentElement.textContent ?? "") : "";
}

function officeFiles(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.byteLength > 24 * 1024 * 1024) throw new Error("This Office file is too large to preview safely.");
  const files: Record<string, Uint8Array> = {};
  const seen = new Set<string>();
  let entries = 0;
  let total = 0;
  let failure: Error | undefined;
  const unzip = new Unzip((file: UnzipFile) => {
    entries += 1;
    const name = file.name;
    const xml = name.toLowerCase() === "[content_types].xml" || /\.(?:xml|rels)$/i.test(name);
    if (entries > 512 || name.length > 1024 || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..") || seen.has(name)) {
      failure ??= new Error("This Office archive contains unsafe or excessive entries.");
      file.ondata = () => {};
      return;
    }
    seen.add(name);
    if (!xml) { file.ondata = () => {}; return; }
    if (file.originalSize !== undefined && file.originalSize > 4 * 1024 * 1024) {
      failure ??= new Error("This Office file expands beyond the safe preview limit.");
      file.ondata = () => {};
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (error) { failure ??= new Error("This Office archive contains a malformed entry."); return; }
      size += chunk.byteLength; total += chunk.byteLength;
      if (size > 4 * 1024 * 1024 || total > 12 * 1024 * 1024) {
        failure ??= new Error("This Office file expands beyond the safe preview limit.");
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) { const output = new Uint8Array(size); let offset = 0; for (const part of chunks) { output.set(part, offset); offset += part.byteLength; } files[name] = output; }
    };
    try { file.start(); } catch { failure ??= new Error("This Office archive contains a malformed entry."); }
  });
  unzip.register(UnzipPassThrough); unzip.register(UnzipInflate);
  try { unzip.push(bytes, true); } catch { failure ??= new Error("This Office file is not a valid ZIP archive."); }
  if (failure) throw failure;
  return files;
}

function officePreview(bytes: ArrayBuffer, kind: "spreadsheet" | "presentation"): OfficeSheet[] | OfficeSlide[] {
  const files = officeFiles(new Uint8Array(bytes));
  const xml = (name: string) => {
    const entry = Object.entries(files).find(([path]) => path.toLowerCase() === name.toLowerCase());
    return entry ? new TextDecoder().decode(entry[1]) : "";
  };
  if (kind === "spreadsheet") {
    const shared = xml("xl/sharedStrings.xml");
    const strings = [...shared.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => xmlText(match[1]));
    const sheets = Object.keys(files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).slice(0, 100);
    return sheets.map((name, index) => {
      const cells = new Map<string, string>();
      const source = new TextDecoder().decode(files[name]);
      for (const match of source.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const ref = match[1].match(/\br="([^"']+)/)?.[1];
        const value = match[2].match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
        const inline = match[2].match(/<is[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/)?.[1];
        if (ref) cells.set(ref.toUpperCase(), inline !== undefined ? xmlText(inline) : match[2].includes('t="s"') ? strings[Number(value)] ?? "" : xmlText(value));
      }
      return { name: `Sheet ${index + 1}`, cells };
    });
  }
  const slides = Object.keys(files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).slice(0, 200);
  return slides.map((name) => {
    const source = new TextDecoder().decode(files[name]);
    const paragraphs = [...source.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) => xmlText(match[1])).filter(Boolean).slice(0, 2000);
    return { title: paragraphs[0] ?? "Untitled slide", paragraphs };
  });
}

function docxText(bytes: ArrayBuffer): string {
  const files = officeFiles(new Uint8Array(bytes));
  const document = files["word/document.xml"];
  if (!document) throw new Error("This Word document has no readable document body.");
  const source = new TextDecoder().decode(document);
  return [...source.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
    .map((paragraph) => [...paragraph[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((text) => xmlText(text[1])).join(""))
    .filter(Boolean).slice(0, 2000).join("\n\n");
}

export class ChatArtifactViewer extends OpenClawLightDomContentsElement {
  @property() src = "";
  @property() sourceIdentity = "";
  @property() label = "";
  @property() mimeType = "";
  @property({ type: Number }) sizeBytes: number | undefined;
  @property() downloadHref = "";
  @state() private status: "loading" | "ready" | "error" = "loading";
  @state() private source = "";
  @state() private error = "";
  @state() private sheet = 0;
  @state() private slide = 0;
  @state() private office: OfficeSheet[] | OfficeSlide[] | null = null;

  private abort?: AbortController;
  private kind: ArtifactKind = "unsupported";

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("src") || changed.has("sourceIdentity") || changed.has("sizeBytes")) void this.load();
  }

  private async load(): Promise<void> {
    this.abort?.abort();
    this.kind = classifyArtifact(this.label, this.mimeType);
    this.status = "loading";
    this.error = "";
    this.source = "";
    this.office = null;
    if (this.kind === "unsupported" || this.kind === "pdf") { this.status = "ready"; return; }
    const limit = artifactPreviewLimit(this.kind)!;
    if (this.sizeBytes !== undefined && this.sizeBytes > limit) { this.fail(`Preview is limited to ${formatBytes(limit)}.`); return; }
    const controller = new AbortController(); this.abort = controller;
    try {
      const response = await fetch(this.src, { credentials: "same-origin", redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error(`Could not load this artifact (${response.status}).`);
      const bytes = await readResponseBytesWithinLimit(response, limit);
      if (!bytes) throw new Error(`Preview is limited to ${formatBytes(limit)}.`);
      if (this.kind === "spreadsheet" || this.kind === "presentation") this.office = officePreview(bytes, this.kind);
      else if (this.kind === "docx") this.source = docxText(bytes);
      else this.source = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (!controller.signal.aborted) this.status = "ready";
    } catch (error) { if (!controller.signal.aborted) this.fail(error instanceof Error ? error.message : "Preview unavailable."); }
  }

  private fail(message: string) { this.status = "error"; this.error = message; }

  override disconnectedCallback(): void { this.abort?.abort(); super.disconnectedCallback(); }

  override render() {
    const kind = this.kind; const label = artifactLabel(kind);
    const markdown = kind === "markdown";
    const rendered = markdown ? toSanitizedMarkdownHtml(this.source, { mode: "document", remoteImages: false, codeBlockInteraction: "interactive" }) : DOMPurify.sanitize(this.source, { USE_PROFILES: { html: true }, FORBID_TAGS: ["base", "embed", "form", "iframe", "link", "meta", "object", "script", "style"], FORBID_ATTR: ["action", "formaction", "srcset", "style", "xlink:href"] });
    const office = this.office;
    return html`<div class="artifact-viewer" aria-label=${this.label}>
      <header class="artifact-viewer__header"><span>${label}</span><strong title=${this.label}>${this.label}</strong><small>${this.sizeBytes === undefined ? nothing : formatBytes(this.sizeBytes)}</small><a href=${this.downloadHref || this.src} download=${this.label} aria-label=${t("chat.mediaPlayer.download", { filename: this.label })}>${icons.download}</a></header>
      <div class="artifact-viewer__body" role="region" tabindex="0" aria-label=${this.label}>
        ${this.status === "loading" ? html`<div class="muted" role="status">${t("common.loading")}</div>` : this.status === "error" ? html`<div role="alert"><strong>Preview unavailable</strong><p>${this.error}</p><a href=${this.downloadHref || this.src} download=${this.label}>Download original</a></div>` : kind === "unsupported" ? html`<div class="muted">No preview for this file type. <a href=${this.downloadHref || this.src} download=${this.label}>Download original</a>.</div>` : kind === "pdf" ? html`<object data=${this.src} type="application/pdf" class="artifact-viewer__pdf"><a href=${this.downloadHref || this.src}>Open PDF</a></object>` : kind === "spreadsheet" && office ? this.renderSpreadsheet(office as OfficeSheet[]) : kind === "presentation" && office ? this.renderPresentation(office as OfficeSlide[]) : kind === "html" ? html`<article class="artifact-viewer__document artifact-viewer__html">${unsafeHTML(rendered)}</article>` : kind === "markdown" ? html`<article class="artifact-viewer__document artifact-viewer__markdown" ${markdownBlocks()}>${unsafeHTML(rendered)}</article>` : html`<pre class="artifact-viewer__source"><code>${this.source}</code></pre>`}
      </div>
    </div>`;
  }

  private renderSpreadsheet(sheets: OfficeSheet[]) { const active = sheets[this.sheet]; return html`<div class="artifact-viewer__office-toolbar">${sheets.length} sheets · cached values only</div><div class="artifact-viewer__spreadsheet" role="region" aria-label=${active?.name ?? "Worksheet"} tabindex="0"><table><tbody>${[...active?.cells.entries() ?? []].slice(0, 10_000).map(([ref, value]) => html`<tr><th>${ref}</th><td>${value}</td></tr>`)}</tbody></table></div><div class="artifact-viewer__sheet-tabs" role="tablist">${sheets.map((item, index) => html`<button type="button" role="tab" aria-selected=${this.sheet === index} @click=${() => (this.sheet = index)}>${item.name}</button>`)}</div>`; }
  private renderPresentation(slides: OfficeSlide[]) { const active = slides[this.slide]; return html`<div class="artifact-viewer__office-toolbar"><button class="btn btn--sm" type="button" ?disabled=${this.slide === 0} @click=${() => this.slide--}>Previous</button> Slide ${this.slide + 1} of ${slides.length} <button class="btn btn--sm" type="button" ?disabled=${this.slide >= slides.length - 1} @click=${() => this.slide++}>Next</button></div><article class="artifact-viewer__slide"><h2>${active?.title}</h2>${active?.paragraphs.slice(1).map((paragraph) => html`<p>${paragraph}</p>`)}</article><p class="muted">Text outline only. Visuals, layout, animations, and speaker notes are omitted.</p>`; }
}
if (!customElements.get("openclaw-chat-artifact-viewer")) customElements.define("openclaw-chat-artifact-viewer", ChatArtifactViewer);
declare global { interface HTMLElementTagNameMap { "openclaw-chat-artifact-viewer": ChatArtifactViewer; } }
