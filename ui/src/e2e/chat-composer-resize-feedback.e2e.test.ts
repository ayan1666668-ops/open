import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { COMPOSER_HEIGHT_STORAGE_KEY } from "../pages/chat/components/chat-composer-resize-geometry.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Composer resize feedback",
  startServerBeforeBrowser: true,
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
suite.define(() => {
  for (const route of ["chat", "new"]) {
    for (const width of [1440, 1600]) {
      it(`${route} at ${width}: agreed handle visibility and reset`, async () => {
        await suite.withPage(
          { viewport: { width, height: 900 }, colorScheme: "dark" },
          async ({ context, page }) => {
            await installMockGateway(page, { historyMessages: [] });
            await page.goto(`${suite.server.baseUrl}${route}`);
            const editor = page.locator(".agent-chat__composer-combobox > textarea");
            await editor.waitFor();
            const top = page.locator(".agent-chat__composer-resize-top");
            const side = page.locator(".agent-chat__composer-resize-side");
            const opacity = () => side.evaluate((el) => getComputedStyle(el).opacity);
            const lines = (count: number) =>
              Array.from({ length: count }, (_, i) => `Line ${i + 1}`).join("\n");
            await editor.fill(lines(5));
            if (route === "chat") {
              const topOpacity = () => top.evaluate((el) => getComputedStyle(el).opacity);
              const dragTop = async (dy: number) => {
                const box = (await top.boundingBox())!;
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                await page.mouse.down();
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, {
                  steps: 8,
                });
                await page.mouse.up();
              };
              await editor.fill("");
              await page.mouse.move(0, 0);
              await expect.poll(topOpacity).toBe("0");
              await top.hover();
              await expect.poll(topOpacity).toBe("1");
              expect(await top.evaluate((el) => getComputedStyle(el, "::before").height)).toBe(
                "3px",
              );
              const color = await top.evaluate(
                (el) => getComputedStyle(el, "::before").backgroundColor,
              );
              await editor.fill(lines(6));
              await page.mouse.move(0, 0);
              await expect.poll(topOpacity).toBe("0");
              await editor.fill(lines(7));
              expect(await top.evaluate((el) => el.classList.contains("is-fixed-height"))).toBe(
                true,
              );
              await expect.poll(topOpacity).toBe("1");
              expect(
                await top.evaluate((el) => getComputedStyle(el, "::before").backgroundColor),
              ).toBe(color);
              await top.dblclick();
              await page.mouse.move(0, 0);
              await expect.poll(topOpacity).toBe("1");
              await editor.fill("one\ntwo\nthree");
              await page.mouse.move(0, 0);
              await expect.poll(topOpacity).toBe("0");
              const threeLineHeight = (await editor.boundingBox())!.height;
              await dragTop(-48);
              await page.mouse.move(0, 0);
              await expect.poll(topOpacity).toBe("1");
              expect((await editor.boundingBox())!.height).toBe(threeLineHeight);
              expect(
                await editor.evaluate((el) => Number.parseFloat(el.style.maxHeight)),
              ).toBeGreaterThan(300);
              await editor.fill(lines(10));
              const tenLineHeight = (await editor.boundingBox())!.height;
              expect(tenLineHeight).toBeGreaterThan(threeLineHeight + 120);
              await editor.fill(lines(12));
              expect((await editor.boundingBox())!.height).toBeGreaterThan(tenLineHeight + 40);
              await page.reload();
              await editor.waitFor();
              expect(
                await editor.evaluate((el) => Number.parseFloat(el.style.maxHeight)),
              ).toBeGreaterThan(300);
              await editor.fill(lines(10));
              // Shrink ten rows to eight: only this action fixes a row limit.
              const lineHeight = await editor.evaluate((el) =>
                Number.parseFloat(getComputedStyle(el).lineHeight),
              );
              await dragTop(lineHeight * 2);
              const fixedHeight = (await editor.boundingBox())!.height;
              expect(Math.abs(fixedHeight - tenLineHeight + lineHeight * 2)).toBeLessThan(2);
              expect(
                await top.evaluate((el) => getComputedStyle(el, "::before").backgroundColor),
              ).toBe(color);
              expect(
                await top.evaluate((el) => getComputedStyle(el, "::before").borderTopWidth),
              ).toBe("0px");
              await editor.fill(lines(14));
              expect((await editor.boundingBox())!.height).toBe(fixedHeight);
              await page.screenshot({
                path: path.join(suite.artifactDir, `${route}-${width}-capped.png`),
              });
              await dragTop(-24);
              expect(
                await editor.evaluate((el) => Number.parseFloat(el.style.maxHeight)),
              ).toBeGreaterThan(300);
              expect((await editor.boundingBox())!.height).toBeGreaterThan(fixedHeight);
              expect(
                await top.evaluate((el) => getComputedStyle(el, "::before").backgroundColor),
              ).not.toBe(color);
              // Grow is bounded by the window without losing the grow preference.
              await editor.fill(lines(100));
              await expect
                .poll(() => top.evaluate((el) => el.classList.contains("is-fixed-height")))
                .toBe(true);
              for (const height of [900, 400, 900]) {
                await page.setViewportSize({ width, height });
                await expect
                  .poll(async () => {
                    const box = await page.locator(".agent-chat__input").boundingBox();
                    return Boolean(box && box.y >= 0 && box.y + box.height <= height);
                  })
                  .toBe(true);
                await page.screenshot({
                  path: path.join(suite.artifactDir, `${route}-${width}-viewport-${height}.png`),
                });
                expect(await editor.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
                expect(await top.evaluate((el) => el.classList.contains("is-fixed-height"))).toBe(
                  true,
                );
              }
              // Numeric preferences share the pane ceiling: in a short split
              // pane, End must not select a window-based cap that overflows
              // the clipped conversation and hides part of the composer.
              await page.setViewportSize({ width, height: 900 });
              // Only the pane's box changes, exactly as a stacked-split divider
              // does: no window resize event. The pane ResizeObserver must
              // recompute the ceiling on its own.
              const setPaneHeight = (px: string) =>
                page.evaluate((value) => {
                  const chat = document.querySelector<HTMLElement>(".card.chat, .chat")!;
                  chat.style.height = value;
                  chat.style.maxHeight = value;
                  chat.style.overflow = value ? "hidden" : "";
                }, px);
              await setPaneHeight("360px");
              await top.focus();
              await top.press("End");
              await expect
                .poll(async () => {
                  const chat = (await page.locator(".card.chat, .chat").first().boundingBox())!;
                  const box = (await page.locator(".agent-chat__input").boundingBox())!;
                  return box.y >= chat.y - 1 && box.y + box.height <= chat.y + chat.height + 1;
                })
                .toBe(true);
              expect(
                Number.parseFloat(await editor.evaluate((el) => el.style.maxHeight)),
              ).toBeLessThan(360);
              expect(await editor.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
              await page.screenshot({
                path: path.join(suite.artifactDir, `${route}-${width}-split-pane-end.png`),
              });
              // The stored preference is the keyboard-selected value; a taller
              // pane renders more of it without another keypress.
              const storedEnd = await page.evaluate(
                (key) => localStorage.getItem(key),
                COMPOSER_HEIGHT_STORAGE_KEY,
              );
              expect(storedEnd).not.toBeNull();
              await setPaneHeight("");
              await expect
                .poll(() => editor.evaluate((el) => Number.parseFloat(el.style.maxHeight)))
                .toBeGreaterThan(360);
              expect(
                await page.evaluate(
                  (key) => localStorage.getItem(key),
                  COMPOSER_HEIGHT_STORAGE_KEY,
                ),
              ).toBe(storedEnd);
              // Same through grow mode with a long draft: shrink the pane by
              // its box alone, the remembered ceiling must follow it down and
              // back up. This is the divider path the window-resize handler
              // never sees.
              await top.press("Enter");
              await editor.fill("one\ntwo\nthree");
              await dragTop(-48);
              await editor.fill(lines(100));
              const tallCeiling = await editor.evaluate((el) =>
                Number.parseFloat(el.style.maxHeight),
              );
              await setPaneHeight("300px");
              await expect
                .poll(() => editor.evaluate((el) => Number.parseFloat(el.style.maxHeight)))
                .toBeLessThan(300);
              const shrunk = (await page.locator(".agent-chat__input").boundingBox())!;
              const shrunkPane = (await page.locator(".card.chat, .chat").first().boundingBox())!;
              expect(shrunk.y + shrunk.height).toBeLessThanOrEqual(
                shrunkPane.y + shrunkPane.height + 1,
              );
              await setPaneHeight("");
              await expect
                .poll(() => editor.evaluate((el) => Number.parseFloat(el.style.maxHeight)))
                .toBe(tallCeiling);
              await top.press("Enter");
              // Width changes must reflow the same draft and recover on widening.
              // Re-enter grow mode first: the reset above restored the default cap,
              // under which a wrapped draft cannot get taller when narrowed.
              await editor.fill("one\ntwo\nthree");
              await dragTop(-48);
              await editor.fill("Wrapped words for window resizing. ".repeat(45));
              const wideHeight = (await editor.boundingBox())!.height;
              await page.setViewportSize({ width: 800, height: 900 });
              await expect
                .poll(async () => (await editor.boundingBox())!.height)
                .toBeGreaterThan(wideHeight);
              const narrowBox = (await page.locator(".agent-chat__input").boundingBox())!;
              expect(narrowBox.y).toBeGreaterThanOrEqual(0);
              expect(narrowBox.y + narrowBox.height).toBeLessThanOrEqual(900);
              await page.setViewportSize({ width, height: 900 });
              await expect.poll(async () => (await editor.boundingBox())!.height).toBe(wideHeight);
              await editor.fill(lines(3));
              await expect
                .poll(() => top.evaluate((el) => el.classList.contains("is-fixed-height")))
                .toBe(false);
              await top.dblclick();
              await editor.fill(lines(6));
              await page.mouse.move(0, 0);
              await expect.poll(topOpacity).toBe("0");
              await editor.fill("Wrapped draft words ".repeat(100));
              await expect.poll(topOpacity).toBe("1");
              expect(await top.getAttribute("title")).toBeNull();
            } else {
              await editor.fill(lines(15));
              expect(await top.count()).toBe(0);
              expect(await editor.evaluate((el) => el.style.maxHeight)).toBe("");
              // Width is owned by settings, not cached here: a Message width
              // change written from another tab must repaint this mounted page
              // through the live settings snapshot, with no grip interaction.
              const shell = page.locator(".agent-chat__composer-shell");
              const before = (await shell.boundingBox())!.width;
              // Settings are scoped to the gateway the page is connected to, not
              // to the test server: take the key the page itself wrote.
              const settingsKey = await page.evaluate(
                () =>
                  Object.keys(localStorage).find((key) =>
                    key.startsWith("openclaw.control.settings.v1:"),
                  ) ?? null,
              );
              expect(settingsKey).not.toBeNull();
              const otherTab = await context.newPage();
              await otherTab.route("**/preference-writer", (request) =>
                request.fulfill({
                  contentType: "text/html",
                  body: "<!doctype html><title>Preference writer</title>",
                }),
              );
              await otherTab.goto(`${suite.server.baseUrl}preference-writer`);
              await otherTab.evaluate((key) => {
                const current = JSON.parse(localStorage.getItem(key) ?? "{}");
                localStorage.setItem(
                  key,
                  JSON.stringify({ ...current, chatMessageMaxWidth: "560px" }),
                );
              }, settingsKey!);
              await expect.poll(async () => (await shell.boundingBox())!.width).toBe(560);
              expect(before).not.toBe(560);
              // Restore the default width the same way, so the shared checks
              // below start from the accepted hover-only state.
              await otherTab.evaluate((key) => {
                const current = JSON.parse(localStorage.getItem(key) ?? "{}");
                delete current.chatMessageMaxWidth;
                localStorage.setItem(key, JSON.stringify(current));
              }, settingsKey!);
              await expect.poll(async () => (await shell.boundingBox())!.width).toBe(before);
              await otherTab.close();
            }
            await editor.hover();
            await expect.poll(opacity).toBe("0");
            await side.hover();
            await expect.poll(opacity).toBe("1");
            expect(await side.getAttribute("title")).toBeNull();
            expect(await side.evaluate((el) => getComputedStyle(el, "::before").width)).toBe("3px");
            expect(
              await side.evaluate((el) => getComputedStyle(el, "::before").backgroundColor),
            ).toBe("rgba(0, 0, 0, 0)");
            expect(
              await side.evaluate((el) => {
                const input = el.closest<HTMLElement>(".agent-chat__input")!;
                const grip = el.getBoundingClientRect();
                const border = input.getBoundingClientRect();
                return Math.abs(
                  grip.x +
                    grip.width / 2 -
                    border.x -
                    Number.parseFloat(getComputedStyle(input).borderLeftWidth) / 2,
                );
              }),
            ).toBeLessThan(0.1);
            const before = (await side.boundingBox())!;
            const x = before.x + before.width / 2,
              y = before.y + before.height / 2;
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x - 40, y, { steps: 8 });
            await page.mouse.up();
            const after = (await side.boundingBox())!;
            expect(Math.abs(after.x - before.x + 40)).toBeLessThan(2);
            await page.mouse.move(0, 0);
            await expect.poll(opacity).toBe("1");
            await page.screenshot({
              path: path.join(suite.artifactDir, `${route}-${width}-custom.png`),
            });
            // A second drag starts with a saved width. Force host renders while
            // holding the pointer: those must not overwrite the drag preview.
            const savedBox = (await side.boundingBox())!;
            const sx = savedBox.x + savedBox.width / 2;
            const sy = savedBox.y + savedBox.height / 2;
            await page.mouse.move(sx, sy);
            await page.mouse.down();
            for (const dx of [10, 20, 30, 40]) {
              await page.mouse.move(sx + dx, sy);
              await editor.evaluate(async (el) => {
                el.dispatchEvent(new InputEvent("input", { bubbles: true }));
                await new Promise<void>((resolve) => {
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                });
              });
              expect(Math.abs((await side.boundingBox())!.x - savedBox.x - dx)).toBeLessThan(2);
            }
            await page.mouse.up();
            expect(Math.abs((await side.boundingBox())!.x - savedBox.x - 40)).toBeLessThan(2);
            await page.screenshot({
              path: path.join(suite.artifactDir, `${route}-${width}-shrink-saved.png`),
            });
            await side.dblclick();
            await expect.poll(opacity).toBe("0");
            await page.mouse.move(0, 0);
            await expect.poll(opacity).toBe("0");
            await side.hover();
            await expect.poll(opacity).toBe("1");
            await page.mouse.move(0, 0);
            await page.screenshot({
              path: path.join(suite.artifactDir, `${route}-${width}-reset.png`),
            });
            await side.focus();
            await side.press("ArrowLeft");
            await side.press("Enter");
            await expect.poll(opacity).toBe("1");
            await writeFile(
              path.join(suite.artifactDir, `${route}-${width}-geometry.json`),
              JSON.stringify({ route, width, before, after }, null, 2),
            );
          },
        );
      });
    }
  }
});
