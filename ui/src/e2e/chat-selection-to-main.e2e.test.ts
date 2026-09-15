import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { storedChatOutboxScopeKey } from "../lib/chat/outbox-store.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI selected text destinations" });
const selectedText = "Review the deployment checklist.";
const draft = "Please explain the next step.";
const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

async function selectText(text: Locator) {
  await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await text.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
}

suite.define(() => {
  it.each(viewports)(
    "stages, edits, restores, and sends annotations at $width px",
    async (viewport) => {
      await suite.withPage(
        {
          viewport,
          locale: "en-US",
          reducedMotion: "reduce",
          serviceWorkers: "block",
          recordVideo: { dir: suite.artifactDir, size: viewport },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            historyMessages: [{ role: "assistant", content: selectedText }],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const composer = page.locator(".agent-chat__composer-shell textarea");
          await composer.waitFor({ state: "visible" });
          const text = page.locator(".chat-bubble .chat-text p").filter({ hasText: selectedText });
          const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
          const editor = page.getByRole("dialog", { name: "Annotation", exact: true });
          const comment = editor.getByRole("textbox");
          const chip = (count: number) =>
            page.getByRole("button", {
              name: count === 1 ? "1 annotation" : `${count} annotations`,
              exact: true,
            });
          const open = async () => {
            await selectText(text);
            await toolbar.getByRole("button", { name: "Add to chat", exact: true }).click();
            await editor.waitFor({ state: "visible" });
          };
          const bounded = async (locator: Locator) => {
            const bounds = await locator.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.y).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
          };
          const capture = async (stage: string) =>
            page.screenshot({
              path: `${suite.artifactDir}/after-${viewport.width}-${stage}.png`,
            });

          await composer.fill(draft);
          await open();
          expect(await comment.inputValue()).toBe("");
          expect(await composer.inputValue()).toBe(draft);
          await bounded(editor);
          await capture("inline-comment");
          await comment.fill("Discard this comment.");
          await editor.getByRole("button", { name: "Cancel", exact: true }).click();
          expect(await chip(1).count()).toBe(0);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);

          await open();
          await comment.fill("Why is this step needed? 🦞");
          await bounded(editor);
          await capture("editor");
          await editor.getByRole("button", { name: "Save", exact: true }).click();
          await chip(1).waitFor({ state: "visible" });
          expect(await composer.inputValue()).toBe(draft);
          await expect
            .poll(() => composer.evaluate((element) => element === document.activeElement))
            .toBe(true);
          await open();
          await comment.press("Enter");
          await chip(2).click();
          const preview = page.getByRole("region", { name: "Annotations", exact: true });
          await preview.waitFor({ state: "visible" });
          expect(await preview.getByText(selectedText, { exact: true }).count()).toBe(2);
          expect(await preview.getByText("User comment:", { exact: true }).count()).toBe(1);
          await bounded(preview);
          await capture("multiple");

          await preview.getByRole("button", { name: "Edit annotation 1", exact: true }).click();
          await comment.fill("An unsaved replacement");
          await comment.press("Escape");
          await chip(2).click();
          expect(await preview.textContent()).toContain("Why is this step needed? 🦞");
          await preview.getByRole("button", { name: "Edit annotation 1", exact: true }).click();
          await comment.fill("Explain the rollback checks. 🦞\nKeep the existing draft.");
          await comment.press("Control+Enter");
          await chip(2).click();
          expect(await preview.textContent()).toContain("Explain the rollback checks. 🦞");
          await preview.getByRole("button", { name: "Edit annotation 2", exact: true }).click();
          await editor.getByRole("button", { name: "Delete annotation", exact: true }).click();
          await chip(1).waitFor({ state: "visible" });
          await page.getByRole("button", { name: "Remove annotations", exact: true }).click();
          expect(await chip(1).count()).toBe(0);
          expect(await composer.inputValue()).toBe(draft);

          await open();
          await comment.fill("Explain the rollback checks. 🦞");
          await editor.getByRole("button", { name: "Save", exact: true }).click();
          await chip(1).click();
          await preview.waitFor({ state: "visible" });
          await bounded(preview);
          await capture("composer");
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          await waitForCommittedComposerDraft(
            page,
            `chat:v3:${storedChatOutboxScopeKey({ agentId: "main", sessionKey: "agent:main:main" })}`,
            draft,
            1,
          );
          await page.reload();
          await chip(1).waitFor({ state: "visible" });
          expect(await composer.inputValue()).toBe(draft);
          await chip(1).click();
          expect(await preview.textContent()).toContain("Explain the rollback checks. 🦞");
          await composer.click();
          await open();
          await comment.press("Enter");
          await chip(2).waitFor({ state: "visible" });
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          const request = await gateway.waitForRequest("chat.send");
          const params = request.params as {
            message: string;
            idempotencyKey: string;
            attachments: Array<{ content: string; mimeType: string; fileName: string }>;
          };
          expect(params.message).toBe(draft);
          expect(params.attachments).toHaveLength(2);
          const contents = params.attachments.map((attachment) => {
            expect(attachment.mimeType).toBe("text/plain");
            return Buffer.from(attachment.content, "base64").toString("utf8");
          });
          expect(contents[0]).toContain(selectedText);
          expect(contents[0]).toContain("Explain the rollback checks. 🦞");
          expect(contents[0]).toContain("agent:main:main");
          expect(contents[1]).toContain(selectedText);
          expect(contents[1]).not.toContain("Explain the rollback checks.");
          await expect.poll(() => composer.inputValue()).toBe("");
          expect(await chip(2).count()).toBe(0);
          await gateway.emitChatFinal({
            runId: params.idempotencyKey,
            text: "The checks are ready.",
          });
        },
      );
    },
  );

  it("keeps formatted selection text and DOM source offsets consistent", async () => {
    await suite.withPage(
      { viewport: viewports[0], locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: "A  \nB" }],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const paragraph = page.locator(".chat-bubble .chat-text p");
        await paragraph.waitFor({ state: "visible" });
        const sourceText = await page.locator(".chat-bubble").textContent();
        const selectedDomText = await paragraph.textContent();
        await selectText(paragraph);
        await page
          .getByRole("toolbar", { name: "Selection actions" })
          .getByRole("button", { name: "Add to chat", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Annotation", exact: true })
          .getByRole("button", { name: "Save annotation", exact: true })
          .click();
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        const params = request.params as { attachments: Array<{ content: string }> };
        const content = Buffer.from(params.attachments[0]!.content, "base64").toString("utf8");
        expect(content).toContain("Selected text:\nA\nB");
        const offsets = /DOM text UTF-16 range: \[(\d+), (\d+)\)/.exec(content);
        expect(offsets).not.toBeNull();
        expect(sourceText?.slice(Number(offsets![1]), Number(offsets![2]))).toBe(selectedDomText);
      },
    );
  });

  it.each(viewports)(
    "preserves side chat and selection dismissal at $width px",
    async (viewport) => {
      await suite.withPage(
        { viewport, locale: "en-US", reducedMotion: "reduce" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            historyMessages: [{ role: "assistant", content: selectedText }],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const composer = page.locator(".agent-chat__composer-shell textarea");
          await composer.fill(draft);
          const text = page.locator(".chat-bubble .chat-text p").filter({ hasText: selectedText });
          const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
          await selectText(text);
          await toolbar.waitFor({ state: "visible" });
          await page.keyboard.press("Escape");
          expect(await toolbar.count()).toBe(0);
          await selectText(text);
          await toolbar.getByRole("button", { name: "Ask in side chat", exact: true }).click();
          const sideComposer = page.locator(".chat-session-rail__input");
          await sideComposer.waitFor({ state: "visible" });
          expect(await sideComposer.inputValue()).toBe(`Regarding "${selectedText}": `);
          expect(await composer.inputValue()).toBe(draft);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    },
  );
});
