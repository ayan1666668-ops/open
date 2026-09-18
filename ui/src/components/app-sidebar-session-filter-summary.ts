import { html, nothing } from "lit";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";
import type { SessionListHost } from "./app-sidebar-session-row-render.ts";
import { icons } from "./icons.ts";
import { renderSessionOwnerAvatar, sessionSelfOwner } from "./session-owner-chip.ts";

/**
 * Quiet toolbar summary of the active sidebar filters. The whole control clears
 * them; its lead glyph (owner avatar, or an archive mark for status-only
 * filters) turns into the clear icon on hover so the row spends no width on a
 * second affordance.
 */
export function renderSessionFilterSummary(host: SessionListHost) {
  const ownerId = host.sessionOwnerFilterActive ? host.sessionOwnerFilterId : null;
  const owner = ownerId
    ? host.sessionOwnerOptions.find((option) => option.id === ownerId)
    : host.sessionInvolvingMeFilterActive
      ? sessionSelfOwner(
          resolveCurrentSelfUser({
            snapshotUser: host.sessionDataContext?.gateway.snapshot.selfUser,
            presenceEntries: readPresenceEntries(host.sessionData.presencePayload),
            presenceInstanceId: host.sessionData.presenceInstanceId,
          }),
        )
      : undefined;
  const parts = [
    ...(ownerId ? [owner?.label ?? ownerId] : []),
    ...(host.sessionInvolvingMeFilterActive ? [t("sessionsView.involvingMe")] : []),
    ...(host.sessionsStatusFilter === "archived"
      ? [t("sessionsView.archived")]
      : host.sessionsStatusFilter === "all"
        ? [t("sessionsView.all")]
        : []),
  ];
  const summaryText = parts.join(" · ");
  const showAll = t("chat.sidebar.showAllSessions");
  return html`<button
    type="button"
    class="sidebar-session-filter-summary"
    title=${showAll}
    aria-label=${`${summaryText} · ${showAll}`}
    @click=${() => {
      host.setSessionOwnerFilter(null);
      if (host.sessionsStatusFilter !== "active") {
        host.sessionOrganizer.setSessionsStatusFilter("active");
      }
    }}
  >
    <span class="sidebar-session-filter-summary__lead" aria-hidden="true">
      <span class="sidebar-session-filter-summary__glyph"
        >${owner ? renderSessionOwnerAvatar(owner) : icons.archive}</span
      >
      <span class="sidebar-session-filter-summary__clear">${icons.x}</span>
    </span>
    <span class="sidebar-session-filter-summary__label"
      >${parts.map(
        (part, index) =>
          html`${
            index > 0
              ? html`<span class="sidebar-session-filter-summary__sep" aria-hidden="true">·</span>`
              : nothing
          }${part}`,
      )}</span
    >
  </button>`;
}

type SessionFilterHost = Pick<
  SessionListHost,
  | "sessionOwnerFilterActive"
  | "sessionInvolvingMeFilterActive"
  | "sessionsStatusFilter"
  | "sessionsShowCron"
  | "sessionsShowSystem"
>;

export function countSidebarSessionFilters(host: SessionFilterHost) {
  return (
    Number(host.sessionOwnerFilterActive || host.sessionInvolvingMeFilterActive) +
    Number(host.sessionsStatusFilter !== "active") +
    Number(host.sessionsShowCron) +
    Number(host.sessionsShowSystem)
  );
}

export function renderSidebarSessionFilter(
  host: SessionFilterHost & Pick<SessionListHost, "sidebarMenus">,
  className: string,
) {
  const count = countSidebarSessionFilters(host);
  return html`<button
    type="button"
    class="${className} sidebar-session-sort ${count > 0 ? "sidebar-session-sort--filtered" : ""}"
    title=${t("chat.sidebar.sortSessions")}
    aria-label=${t("chat.sidebar.sortSessions")}
    aria-description=${count > 0 ? t("chat.sidebar.activeFilterCount", { count: String(count) }) : nothing}
    aria-haspopup="dialog"
    aria-expanded=${String(host.sidebarMenus.sessionSortMenuPosition !== null)}
    @click=${(event: MouseEvent) => {
      if (event.currentTarget instanceof HTMLElement) {
        host.sidebarMenus.toggleSessionSortMenu(event.currentTarget);
      }
    }}
  >
    ${icons.listFilter}
    ${count > 0 ? html`<span class="sidebar-session-filter-count" aria-hidden="true">${count}</span>` : nothing}
  </button>`;
}
