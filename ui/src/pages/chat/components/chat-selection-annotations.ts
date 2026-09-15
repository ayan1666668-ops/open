import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import "../../../styles/chat/selection-annotations.css";

registerChatMessageMetadataEnglish();

/** The composer reports staged comments; their source pins own editing. */
export function renderChatSelectionAnnotations(props: ChatAttachmentControlsProps) {
  const count =
    props.attachments?.filter((attachment) => attachment.selectionAnnotation).length ?? 0;
  return count
    ? html`<span class="chat-selection-annotations__chip">
        <span aria-hidden="true">${icons.messageSquare}</span>
        ${t(count === 1 ? "chat.messages.annotationCount" : "chat.messages.annotationsCount", { count: String(count) })}
      </span>`
    : nothing;
}
