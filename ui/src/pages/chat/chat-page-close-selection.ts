import type { RouteLocation } from "@openclaw/uirouter";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { SessionChatRouteData } from "./session-route-data.ts";

type CloseSelectionBindings = {
  data: () => SessionChatRouteData | undefined;
  router: () => ApplicationContext["router"] | undefined;
  presented: () => boolean;
  changed: () => void;
};

/** Keeps a collapsed pane's session coherent until the route publishes its next selection. */
export class ChatPageCloseSelection implements ReactiveController {
  private selection:
    | {
        data: SessionChatRouteData | undefined;
        sessionKey: string;
        router: ApplicationContext["router"] | undefined;
        location?: RouteLocation;
      }
    | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly bindings: CloseSelectionBindings,
  ) {
    host.addController(this);
  }

  get sessionKey(): string {
    const data = this.bindings.data();
    return this.selection && this.selection.data === data
      ? this.selection.sessionKey
      : (data?.sessionKey?.trim() ?? "");
  }

  preserve(sessionKey: string): void {
    this.clear();
    const data = this.bindings.data();
    if (data && areUiSessionKeysEquivalent(data.sessionKey, sessionKey)) {
      return;
    }
    const router = this.bindings.router();
    this.selection = { data, sessionKey, router };
    this.unsubscribe = router?.subscribe(() => this.host.requestUpdate());
  }

  navigated(): void {
    if (this.selection) {
      this.selection.location = this.selection.router?.getState().location;
    }
  }

  hostUpdate(): void {
    const pending = this.selection;
    if (!pending) {
      return;
    }
    const router = this.bindings.router();
    const route = router?.getState();
    if (
      !this.bindings.presented() ||
      this.bindings.data() !== pending.data ||
      router !== pending.router ||
      (route?.status === "success" &&
        route.location !== pending.location &&
        route.matches[0]?.data === pending.data)
    ) {
      // Cancellation can restore the same cached data at a new location. A pending
      // replacement keeps the survivor until its own route data reaches the page.
      this.clear();
      if (this.bindings.presented()) {
        this.bindings.changed();
      }
    }
  }

  hostDisconnected(): void {
    this.clear();
  }

  private clear(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.selection = undefined;
  }
}
