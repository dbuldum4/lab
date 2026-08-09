import { expect, test } from "@playwright/test";

test("the app exposes an installable local-first manifest", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.name).toBe("lab");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  expect(manifest.scope).toBe("/");
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: "/lab-icon.svg", type: "image/svg+xml" }),
  ]));

  const icon = await request.get("/lab-icon.svg");
  expect(icon.ok()).toBe(true);
});
