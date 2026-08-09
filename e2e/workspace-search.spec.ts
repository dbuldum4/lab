import { expect, test } from "@playwright/test";

test("search finds content in another local session and opens it", async ({ page }) => {
  await page.goto("/");
  let editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await editor.click();
  await editor.fill("secret banana lives here");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/name");
  await page.keyboard.press("Enter");
  const nameInput = page.getByLabel("Session name");
  await nameInput.fill("Alpha");
  await page.keyboard.press("Enter");

  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/new");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#session=/);

  editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await editor.click();
  await editor.fill("second note");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/name");
  await page.keyboard.press("Enter");
  await page.getByLabel("Session name").fill("Beta");
  await page.keyboard.press("Enter");

  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/search");
  await page.keyboard.press("Enter");

  const search = page.getByTestId("workspace-search-input");
  await search.fill("banana");
  const results = page.getByTestId("workspace-search-results");
  await expect(results).toContainText("Alpha");
  await expect(results).toContainText("secret banana lives here");
  await page.keyboard.press("Enter");

  await expect(page).not.toHaveURL(/#session=/);
  await expect(page.getByRole("textbox", { name: "lab local-only Markdown note" })).toContainText("secret banana lives here");
});
