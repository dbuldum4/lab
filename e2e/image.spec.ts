import { expect, test } from "@playwright/test";
import { openEditor, waitForAuthority } from "./helpers";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function pngFile(name = "red.png") {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  };
}

function svgFile(name = "sample.svg") {
  return {
    name,
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="200" height="240" fill="#e85d75"/><rect x="200" width="200" height="240" fill="#4e79a7"/></svg>',
    ),
  };
}

test("the /image slash command inserts a base64 image", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.type("/image");
  await expect(page.locator("#slash-command-palette")).toContainText("Image");
  await page.keyboard.press("Enter");

  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles(pngFile());

  const img = editor.locator("img.lab-image");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("alt", "red");
  await expect(img).toHaveAttribute("src", /data:image\/png;base64,/);

  await waitForAuthority(page, /!\[red\]\(data:image\/png;base64,/);
});

test("pasting an image file inserts a base64 image", async ({ page }) => {
  const editor = await openEditor(page);

  await editor.evaluate((node) => {
    const buffer = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const file = new File([buffer], "pasted.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  });

  const img = editor.locator("img.lab-image");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("alt", "pasted");
  await expect(img).toHaveAttribute("src", /data:image\/png;base64,/);

  await waitForAuthority(page, /!\[pasted\]\(data:image\/png;base64,/);
});

test("pasting an image follows the current selection after a concurrent edit", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await page.keyboard.type("before");

  await page.evaluate(() => {
    const originalReadAsDataURL = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (blob: Blob) {
      window.setTimeout(() => originalReadAsDataURL.call(this, blob), 300);
    };
  });

  await editor.evaluate((node) => {
    const buffer = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const file = new File([buffer], "concurrent.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  });
  await page.keyboard.type("after");

  await expect(editor.locator("img.lab-image")).toBeVisible();
  await expect.poll(async () => editor.evaluate((node) => Array.from(node.querySelectorAll(":scope > *")).map((element) => {
    if (element.tagName === "IMG") return "img";
    if (element.tagName === "P") return `p:${element.textContent ?? ""}`;
    return element.tagName.toLowerCase();
  }))).toEqual(["p:beforeafter", "img", "p:"]);
});

test("pasting an image inside a code block preserves code-block text", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await editor.type("/code");
  await expect(page.locator("#slash-command-palette")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor.locator("pre")).toBeVisible();

  await editor.evaluate((node) => {
    const buffer = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const file = new File([buffer], "code-image.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    dataTransfer.setData("text/plain", "const pasted = true;");
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  });

  await expect(editor.locator("pre code")).toHaveText("const pasted = true;");
  await expect(editor.locator("img.lab-image")).toHaveCount(0);
});

test("dropping an image inside a code block does not insert an image", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await editor.type("/code");
  await expect(page.locator("#slash-command-palette")).toBeVisible();
  await page.keyboard.press("Enter");
  const codeBlock = editor.locator("pre");
  await expect(codeBlock).toBeVisible();
  const box = await codeBlock.boundingBox();
  if (!box) throw new Error("Code block bounding box not available");

  await editor.evaluate((node, coords) => {
    const buffer = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const file = new File([buffer], "dropped-code-image.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    node.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: coords.x,
        clientY: coords.y,
        dataTransfer,
      }),
    );
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

  await expect(editor.locator("img.lab-image")).toHaveCount(0);
  await expect(editor.locator("pre")).toBeVisible();
});

test("dropping an image file inserts a base64 image", async ({ page }) => {
  const editor = await openEditor(page);
  const box = await editor.boundingBox();
  if (!box) throw new Error("Editor bounding box not available");

  await editor.evaluate((node, coords) => {
    const buffer = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const file = new File([buffer], "dropped.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    node.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: coords.x,
        clientY: coords.y,
        dataTransfer,
      }),
    );
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

  const img = editor.locator("img.lab-image");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("alt", "dropped");
  await expect(img).toHaveAttribute("src", /data:image\/png;base64,/);

  await waitForAuthority(page, /!\[dropped\]\(data:image\/png;base64,/);
});

test("dropping an image inserts at the pointer, not the caret", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await page.keyboard.type("AAAA");
  await page.keyboard.press("Enter");
  await page.keyboard.type("BBBB");
  // Caret remains at the end of BBBB. Drop onto the first paragraph instead.
  const firstBox = await editor.locator("p").first().boundingBox();
  if (!firstBox) throw new Error("First paragraph bounding box not available");

  await editor.evaluate((node, coords) => {
    const buffer = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const file = new File([buffer], "drop-pos.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    node.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: coords.x,
        clientY: coords.y,
        dataTransfer,
      }),
    );
  }, { x: firstBox.x + Math.min(24, firstBox.width / 2), y: firstBox.y + firstBox.height / 2 });

  await expect(editor.locator("img.lab-image")).toBeVisible();
  // Image must appear before the BBBB paragraph (drop target was AAAA, caret was at BBBB).
  // Without posAtCoords the image would land after BBBB.
  await expect.poll(async () => {
    return editor.evaluate((node) => {
      const blocks = Array.from(node.querySelectorAll(":scope > *")).map((el) => {
        if (el.tagName === "IMG") return "img";
        if (el.tagName === "P") {
          const text = el.textContent ?? "";
          return text.length === 0 || text === "\u200B" ? "p:empty" : `p:${text}`;
        }
        return el.tagName.toLowerCase();
      });
      return {
        imgIndex: blocks.indexOf("img"),
        bbbbIndex: blocks.findIndex((b) => b.includes("BBBB")),
        hasA: blocks.some((b) => b.includes("A")),
      };
    });
  }).toEqual(expect.objectContaining({
    hasA: true,
  }));

  const layout = await editor.evaluate((node) => {
    const blocks = Array.from(node.querySelectorAll(":scope > *")).map((el) => {
      if (el.tagName === "IMG") return "img";
      if (el.tagName === "P") {
        const text = el.textContent ?? "";
        return text.length === 0 || text === "\u200B" ? "p:empty" : `p:${text}`;
      }
      return el.tagName.toLowerCase();
    });
    return {
      imgIndex: blocks.indexOf("img"),
      bbbbIndex: blocks.findIndex((b) => b.includes("BBBB")),
    };
  });
  expect(layout.imgIndex).toBeGreaterThanOrEqual(0);
  expect(layout.bbbbIndex).toBeGreaterThanOrEqual(0);
  expect(layout.imgIndex).toBeLessThan(layout.bbbbIndex);
});

test("multiple images do not add blank paragraphs between images", async ({ page }) => {
  const editor = await openEditor(page);
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles([
    pngFile("one.png"),
    pngFile("two.png"),
  ]);

  await expect(editor.locator("img.lab-image")).toHaveCount(2);
  await expect.poll(async () => {
    return editor.evaluate((node) => Array.from(node.querySelectorAll(":scope > *")).map((element) => {
      if (element.tagName === "IMG") return "img";
      if (element.tagName === "P") {
        const text = element.textContent ?? "";
        return text.length === 0 || text === "\u200B" ? "p:empty" : `p:${text}`;
      }
      return element.tagName.toLowerCase();
    }));
  }).toEqual(["img", "img", "p:empty"]);
});

test("pasting an image mid-paragraph does not insert a blank paragraph", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await page.keyboard.type("Hello world!");
  // Place the caret after "Hello " (6 chars from start of the textblock).
  await editor.evaluate((node) => {
    const selection = window.getSelection();
    const textNode = node.querySelector("p")?.firstChild;
    if (!selection || !textNode || textNode.nodeType !== Node.TEXT_NODE) {
      throw new Error("Expected a text node inside the editor paragraph");
    }
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  });

  await editor.evaluate((node) => {
    const buffer = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const file = new File([buffer], "pasted.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  });

  await expect(editor.locator("img.lab-image")).toBeVisible();
  // Expect: <p>Hello </p><img>...<p>world!</p> — no empty paragraph between image and trailing text.
  await expect.poll(async () => {
    return editor.evaluate((node) => {
      const blocks = Array.from(node.querySelectorAll(":scope > *")).map((el) => {
        if (el.tagName === "IMG") return "img";
        if (el.tagName === "P") {
          const text = el.textContent ?? "";
          return text.length === 0 || text === "\u200B" ? "p:empty" : `p:${text}`;
        }
        return el.tagName.toLowerCase();
      });
      return blocks;
    });
  }).toEqual(["p:Hello ", "img", "p:world!"]);

  await waitForAuthority(page, /Hello\s*\n\n!\[pasted\]\(data:image\/png;base64,[^)]+\)\s*\n\nworld!/);
});

test("oversized images are rejected with a notice", async ({ page }) => {
  const editor = await openEditor(page);
  // Build the oversized File in the page so size is exact and we avoid multi-MB IPC payload flakiness.
  await page.locator('input[type="file"][accept*="image/*"]').evaluate((input) => {
    const file = new File([new Uint8Array(1_500_001)], "huge.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const element = input as HTMLInputElement;
    element.files = transfer.files;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const notice = page.getByTestId("editor-notice");
  await expect(notice).toContainText(/too large to store locally/i, {
    timeout: 10000,
  });
  await expect(notice).toHaveAttribute("role", "alert");
  await expect(notice).toHaveAttribute("aria-live", "assertive");
  await notice.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(notice).toBeHidden();
  await expect(editor.locator("img.lab-image")).toHaveCount(0);
});

test("rich HTML with a remote image URL does not insert a broken image", async ({ page }) => {
  const editor = await openEditor(page);

  await editor.evaluate((node) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", '<p>See <img src="https://example.com/remote.png" alt="remote"></p>');
    dataTransfer.setData("text/plain", "See ");
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  });

  await expect(editor.locator("img")).toHaveCount(0);
  await expect(editor.locator('img[src*="example.com"]')).toHaveCount(0);
});

test("blob image URLs are rejected before they can be persisted", async ({ page }) => {
  const editor = await openEditor(page);

  await editor.evaluate((node) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", '<p>See <img src="blob:http://127.0.0.1:3100/expired-image" alt="blob"></p>');
    dataTransfer.setData("text/plain", "See ");
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  });

  await expect(editor.locator("img")).toHaveCount(0);
  await expect(editor).toContainText("See");
});

test("typed remote image Markdown does not create an image", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.click();
  await page.keyboard.type("![remote](https://example.com/remote.png)");

  await expect(editor.locator("img")).toHaveCount(0);
});

test("image alt with special characters is escaped in Markdown export", async ({ page }) => {
  const editor = await openEditor(page);
  await editor.type("/image");
  await page.keyboard.press("Enter");
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles(pngFile("a]b.png"));

  const img = editor.locator("img.lab-image");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("alt", "a]b");

  await waitForAuthority(page, /!\[a\\\]b\]\(data:image\/png;base64,/);
});

test("clicking an image exposes resize, crop, and delete actions", async ({ page }) => {
  const editor = await openEditor(page);
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles(svgFile());

  const image = editor.locator("img.lab-image");
  await expect(image).toBeVisible();
  await image.click();
  await expect(page.getByRole("button", { name: "Crop image" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Center image" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resize image bottom-right" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resize image left" })).toBeVisible();

  await page.getByRole("button", { name: "Center image" }).click();
  await expect(image).toHaveAttribute("data-image-align", "center");
  await expect(page.getByRole("button", { name: "Uncenter image" })).toBeVisible();
  await waitForAuthority(page, /align=center/);

  await page.getByRole("button", { name: "Uncenter image" }).click();
  await expect(image).not.toHaveAttribute("data-image-align");
  await expect(page.getByRole("button", { name: "Center image" })).toBeVisible();

  await page.getByRole("button", { name: "Delete image" }).click();
  await expect(editor.locator("img.lab-image")).toHaveCount(0);
});

test("resizing an image preserves its aspect ratio and persists its size", async ({ page }) => {
  const editor = await openEditor(page);
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles(svgFile());

  const image = editor.locator("img.lab-image");
  await expect(image).toBeVisible();
  await image.click();
  const handle = page.getByRole("button", { name: "Resize image bottom-right" });
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("Resize handle was not laid out");
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 100, startY + 60);
  await page.mouse.up();

  await expect.poll(() => image.getAttribute("style")).toMatch(/width: \d+px/);
  await waitForAuthority(page, /lab-size:\d+x\d+/);

  await page.setViewportSize({ width: 500, height: 800 });
  await expect.poll(async () => image.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 ? Math.abs(rect.height / rect.width - 0.6) : 1;
  })).toBeLessThan(0.02);
});

test("cropping an image creates a local cropped data URL", async ({ page }) => {
  const editor = await openEditor(page);
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles(svgFile());

  const image = editor.locator("img.lab-image");
  await expect(image).toBeVisible();
  await image.click();
  await page.getByRole("button", { name: "Crop image" }).click();

  const stage = page.locator(".image-crop-stage");
  await expect(stage).toBeVisible();
  const stageBox = await stage.boundingBox();
  if (!stageBox) throw new Error("Crop stage was not laid out");
  await page.mouse.move(stageBox.x + 24, stageBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.width * 0.7, stageBox.y + stageBox.height * 0.75);
  await page.mouse.up();
  await page.getByRole("button", { name: "Apply crop" }).click();

  await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/);
  await waitForAuthority(page, /!\[sample\]\(data:image\/png;base64,/);
});

test("image dialogs keep keyboard focus inside and restore the originating control", async ({ page }) => {
  const editor = await openEditor(page);
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles(pngFile());

  const image = editor.locator("img.lab-image");
  await expect(image).toBeVisible();

  const metadataButton = page.getByRole("button", { name: "Details image" });
  await image.click();
  await metadataButton.click();

  const metadataDialog = page.getByRole("dialog", { name: "Image metadata" });
  const altInput = metadataDialog.getByLabel("Alternative text");
  const titleInput = metadataDialog.getByLabel("Title");
  const closeMetadata = metadataDialog.getByRole("button", { name: "Close image metadata" });
  const saveMetadata = metadataDialog.getByRole("button", { name: "Save metadata" });
  await expect(altInput).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(titleInput).toBeFocused();
  await saveMetadata.focus();
  await page.keyboard.press("Tab");
  await expect(closeMetadata).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(saveMetadata).toBeFocused();

  await page.evaluate(() => {
    const outside = document.createElement("button");
    outside.type = "button";
    outside.id = "focus-trap-outside";
    outside.textContent = "Outside dialog";
    document.body.append(outside);
    outside.focus();
  });
  await expect(altInput).toBeFocused();
  await altInput.fill("discarded");
  await page.keyboard.press("Escape");
  await expect(metadataDialog).toHaveCount(0);
  await expect(image).toHaveAttribute("alt", "red");
  await expect(metadataButton).toBeFocused();

  const cropButton = page.getByRole("button", { name: "Crop image" });
  await cropButton.click();

  const cropDialog = page.getByRole("dialog", { name: "Crop image" });
  const closeCrop = cropDialog.getByRole("button", { name: "Close crop editor" });
  const cancelCrop = cropDialog.getByRole("button", { name: "Cancel crop" });
  const applyCrop = cropDialog.getByRole("button", { name: "Apply crop" });
  await expect(closeCrop).toBeFocused();
  await expect(applyCrop).toBeEnabled();

  await page.keyboard.press("Tab");
  await expect(cancelCrop).toBeFocused();
  await applyCrop.focus();
  await page.keyboard.press("Tab");
  await expect(closeCrop).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(applyCrop).toBeFocused();

  await page.evaluate(() => {
    const outside = document.getElementById("focus-trap-outside");
    outside?.focus();
  });
  await expect(closeCrop).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(cropDialog).toHaveCount(0);
  await expect(cropButton).toBeFocused();
});

test("cancelling crop returns focus to the originating crop control", async ({ page }) => {
  const editor = await openEditor(page);
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles(svgFile());

  const image = editor.locator("img.lab-image");
  await expect(image).toBeVisible();
  await image.click();
  const cropButton = page.getByRole("button", { name: "Crop image" });
  await cropButton.click();
  await expect(page.getByRole("dialog", { name: "Crop image" })).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page.getByRole("dialog", { name: "Crop image" })).toHaveCount(0);
  await expect(cropButton).toBeFocused();
});
