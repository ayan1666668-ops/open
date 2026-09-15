import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { configureAnchoredPopup } from "../../../components/anchored-overlay.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatAttachment, ChatSelectionAnnotation } from "../../../lib/chat/chat-types.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import {
  generateAttachmentId,
  registerChatAttachmentPayload,
  releaseDisplacedChatAttachmentPayloads,
} from "../attachment-payload-store.ts";
import { admitAttachmentFiles } from "./chat-attachment-admission.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { encodeTextAsDataUrl } from "./chat-attachment-text.ts";
import { showChatAnnotationEditor } from "./chat-selection-popup.ts";
import "../../../styles/chat/selection-annotations.css";

registerChatMessageMetadataEnglish();

type SelectionAttachment = ChatAttachment & { selectionAnnotation: ChatSelectionAnnotation };

export function createChatSelectionAttachment(
  annotation: ChatSelectionAnnotation,
  limits?: ChatAttachmentControlsProps["attachmentLimits"],
): ChatAttachment | null {
  const text = [
    `Selected text:\n${annotation.text}`,
    ...(annotation.comment.trim() ? [`User comment:\n${annotation.comment}`] : []),
    [
      `Source session: ${annotation.sessionKey}`,
      ...(annotation.messageId ? [`Source message: ${annotation.messageId}`] : []),
      ...(annotation.entryId ? [`Source entry: ${annotation.entryId}`] : []),
      `DOM text UTF-16 range: [${annotation.start}, ${annotation.end})`,
    ].join("\n"),
  ].join("\n\n");
  const file = new File([text], "selection-comment.txt", { type: "text/plain" });
  if (admitAttachmentFiles([file], limits).length === 0) {
    return null;
  }
  return registerChatAttachmentPayload({
    attachment: {
      id: generateAttachmentId(),
      mimeType: file.type,
      fileName: file.name,
      sizeBytes: file.size,
      selectionAnnotation: { ...annotation },
    },
    dataUrl: encodeTextAsDataUrl(text),
    file,
  });
}

class ChatSelectionAnnotations extends OpenClawLightDomElement {
  @property({ attribute: false }) props!: ChatAttachmentControlsProps;
  @state() private open = false;

  private get trigger() {
    return this.querySelector<HTMLButtonElement>(".chat-selection-annotations__trigger");
  }

  private currentAttachments(): ChatAttachment[] {
    return this.props.getAttachments?.() ?? this.props.attachments ?? [];
  }

  private annotations(): SelectionAttachment[] {
    return this.currentAttachments().filter((attachment): attachment is SelectionAttachment =>
      Boolean(attachment.selectionAnnotation),
    );
  }

  private readonly closePreview = () => {
    this.open = false;
    this.ownerDocument.removeEventListener("pointerdown", this.handleOutsidePointer, true);
  };

  private readonly handleOutsidePointer = (event: PointerEvent) => {
    if (!event.composedPath().includes(this)) {
      this.closePreview();
    }
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !this.contains(event.relatedTarget)) {
      this.closePreview();
    }
  };

  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (this.open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closePreview();
      this.trigger?.focus({ preventScroll: true });
    }
  };

  protected override willUpdate(changed: PropertyValues<this>) {
    const previous = changed.get("props");
    if (changed.has("props") && previous?.readSignal !== this.props.readSignal) {
      previous?.readSignal?.removeEventListener("abort", this.closePreview);
      this.props.readSignal?.addEventListener("abort", this.closePreview, { once: true });
      this.closePreview();
    }
    if (this.props.disabled || this.props.readSignal?.aborted) {
      this.closePreview();
    }
  }

  protected override updated() {
    const popup = this.querySelector<WaPopup>("wa-popup");
    if (this.open && popup && this.trigger) {
      configureAnchoredPopup(popup, this.trigger, "top");
    }
  }

  override disconnectedCallback() {
    this.closePreview();
    this.props.readSignal?.removeEventListener("abort", this.closePreview);
    super.disconnectedCallback();
  }

  private changeAttachments(current: ChatAttachment[], next: ChatAttachment[]) {
    this.props.onAttachmentsChange?.(next);
    releaseDisplacedChatAttachmentPayloads(current, [next]);
  }

  private focusComposer() {
    this.closest(".agent-chat__composer-shell, .new-session-page__composer")
      ?.querySelector<HTMLElement>(".agent-chat__composer-combobox > textarea")
      ?.focus({ preventScroll: true });
  }

  private canChange(signal: AbortSignal | undefined): boolean {
    return (
      this.isConnected &&
      !this.props.disabled &&
      !signal?.aborted &&
      this.props.readSignal === signal &&
      Boolean(this.props.onAttachmentsChange)
    );
  }

  private editAnnotation(attachment: SelectionAttachment, anchor: HTMLElement) {
    const signal = this.props.readSignal;
    if (!this.canChange(signal)) {
      return;
    }
    const anchorRect = anchor.getBoundingClientRect();
    this.closePreview();
    showChatAnnotationEditor({
      anchorRect,
      comment: attachment.selectionAnnotation.comment,
      expanded: true,
      readSignal: signal,
      onSave: (comment): boolean => {
        if (!this.canChange(signal)) {
          return true;
        }
        const current = this.currentAttachments();
        const selected = current.find((item) => item.id === attachment.id);
        if (!selected?.selectionAnnotation) {
          return true;
        }
        const replacement = createChatSelectionAttachment(
          { ...selected.selectionAnnotation, comment },
          this.props.attachmentLimits,
        );
        if (!replacement) {
          return false;
        }
        this.changeAttachments(
          current,
          current.map((item) => (item.id === attachment.id ? replacement : item)),
        );
        this.focusComposer();
        return true;
      },
      onDelete: () => {
        if (!this.canChange(signal)) {
          return;
        }
        const current = this.currentAttachments();
        this.changeAttachments(
          current,
          current.filter((item) => item.id !== attachment.id),
        );
        this.focusComposer();
      },
      onCancel: () => this.trigger?.focus({ preventScroll: true }),
    });
  }

  protected override render() {
    const annotations = this.annotations();
    const disabled = this.props.disabled || this.props.readSignal?.aborted;
    const countLabel = t(
      annotations.length === 1 ? "chat.messages.annotationCount" : "chat.messages.annotationsCount",
      { count: String(annotations.length) },
    );
    return html` <div
      class="chat-selection-annotations__chip"
      @keydown=${this.handleKeydown}
      @focusout=${this.handleFocusOut}
    >
      <button
        type="button"
        class="chat-selection-annotations__trigger"
        aria-label=${countLabel}
        aria-expanded=${String(this.open)}
        ?disabled=${disabled}
        @click=${() => {
          if (this.open) {
            this.closePreview();
          } else if (!disabled) {
            this.open = true;
            this.ownerDocument.addEventListener("pointerdown", this.handleOutsidePointer, true);
          }
        }}
      >
        <span aria-hidden="true">${icons.messageSquare}</span>${countLabel}
      </button>
      <button
        type="button"
        class="chat-selection-annotations__remove"
        aria-label=${t("chat.messages.removeAnnotations")}
        ?disabled=${disabled || !this.props.onAttachmentsChange}
        @click=${() => {
          if (!this.canChange(this.props.readSignal)) {
            return;
          }
          const current = this.currentAttachments();
          this.closePreview();
          this.changeAttachments(
            current,
            current.filter((item) => !item.selectionAnnotation),
          );
          this.focusComposer();
        }}
      >
        ${icons.x}
      </button>
      <wa-popup ?active=${this.open}>
        <section
          class="chat-selection-annotations__preview"
          role="region"
          aria-label=${t("chat.messages.annotations")}
        >
          <h3>${t("chat.messages.annotations")}</h3>
          <ol>
            ${annotations.map(
              (attachment, index) => html` <li>
                <div class="chat-selection-annotations__item">
                  <div class="chat-selection-annotations__text">
                    <strong>${t("chat.messages.annotationSelectedText")}</strong>
                    <p>${attachment.selectionAnnotation.text}</p>
                    ${
                      attachment.selectionAnnotation.comment.trim()
                        ? html` <strong>${t("chat.messages.annotationUserComment")}</strong>
                            <p>${attachment.selectionAnnotation.comment}</p>`
                        : nothing
                    }
                  </div>
                  <button
                    type="button"
                    class="chat-selection-annotations__edit"
                    aria-label=${t("chat.messages.editAnnotation", { number: String(index + 1) })}
                    ?disabled=${disabled || !this.props.onAttachmentsChange}
                    @click=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLElement) {
                        this.editAnnotation(attachment, event.currentTarget);
                      }
                    }}
                  >
                    ${icons.pencil}
                  </button>
                </div>
              </li>`,
            )}
          </ol>
        </section>
      </wa-popup>
    </div>`;
  }
}

customElements.define("openclaw-chat-selection-annotations", ChatSelectionAnnotations);

export function renderChatSelectionAnnotations(props: ChatAttachmentControlsProps) {
  return props.attachments?.some((attachment) => attachment.selectionAnnotation)
    ? html`<openclaw-chat-selection-annotations
        .props=${props}
      ></openclaw-chat-selection-annotations>`
    : nothing;
}
