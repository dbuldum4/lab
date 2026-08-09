import { expect, test } from "@playwright/test";
import { openEditor } from "./helpers";

async function importMarkdown(page: Parameters<typeof openEditor>[0], markdown: string) {
  await page.locator('input[type="file"][accept*="markdown"]').setInputFiles({
    name: "outline.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(markdown),
  });
}

test("the outline command reflects headings, tracks the current section, and navigates by keyboard", async ({ page }) => {
  const editor = await openEditor(page);

  await editor.type("/outline");
  await expect(page.locator("#slash-command-palette")).toContainText("Outline");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("document-outline")).toBeVisible();
  await page.getByRole("button", { name: "Close outline" }).click();

  await importMarkdown(page, "# Plan\n\n## Research\n\n### Sources\n\n## Launch\n\nNotes");
  await expect(editor.locator("h1")).toHaveText("Plan");
  await expect(editor.locator("h2")).toHaveCount(2);
  await expect(editor.locator("h3")).toHaveText("Sources");

  await editor.press("ControlOrMeta+Shift+o");
  const outline = page.getByTestId("document-outline");
  await expect(outline).toBeVisible();
  const items = outline.locator(".outline-item");
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toHaveAttribute("data-level", "1");
  await expect(items.nth(1)).toHaveAttribute("data-level", "2");
  await expect(items.nth(2)).toHaveAttribute("data-level", "3");
  await expect(items.nth(0)).toHaveAttribute("aria-current", "location");

  const launch = outline.getByRole("button", { name: "Launch", exact: true });
  await launch.focus();
  await launch.press("Enter");
  await expect(launch).toHaveAttribute("aria-current", "location");
  await expect(editor).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(outline).toBeHidden();

  await editor.press("ControlOrMeta+Shift+o");
  await expect(page.getByTestId("document-outline")).toBeVisible();
  await importMarkdown(page, "# Plan\n\n## Discovery\n\n### Sources\n\n## Launch\n\nNotes");
  await expect(page.getByTestId("document-outline").getByRole("button", { name: "Discovery", exact: true })).toBeVisible();
  await expect(page.getByTestId("document-outline").getByRole("button", { name: "Research", exact: true })).toHaveCount(0);
});

test("outline visibility is local to the current page and stays inside a narrow viewport", async ({ page }) => {
  const editor = await openEditor(page);
  await importMarkdown(page, "# A heading\n\n## A subsection");
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.press("ControlOrMeta+Shift+o");

  const outline = page.getByTestId("document-outline");
  await expect(outline).toBeVisible();
  const box = await outline.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(await outline.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");

  await page.reload();
  await openEditor(page);
  await expect(page.getByTestId("document-outline")).toBeHidden();
});
