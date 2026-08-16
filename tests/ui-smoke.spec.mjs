import { expect, test } from "@playwright/test";

function squareStl(size = 10) {
  const p = [[0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0], [0, 0, size], [size, 0, size], [size, size, size], [0, size, size]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return `solid square\n${faces.map((face) => `facet normal 0 0 0\n outer loop\n${face.map((index) => `  vertex ${p[index].join(" ")}`).join("\n")}\n endloop\nendfacet`).join("\n")}\nendsolid square\n`;
}

test("PrintNest keeps controls legible, adjusts clearance by wheel, and fills a 256 mm bed", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Plan a build plate" })).toBeVisible();

  const contrast = await page.locator(".controls-sidebar .panel-heading").evaluate((node) => getComputedStyle(node).color);
  expect(contrast).not.toBe("rgb(0, 0, 0)");

  const clearance = page.locator("#clearance");
  await clearance.hover();
  await page.mouse.wheel(0, -100);
  await expect(clearance).toHaveValue("2.1");
  await clearance.fill("2");
  await expect(clearance).toHaveValue("2");

  await page.locator('input[type="file"]').setInputFiles({ name: "square.stl", mimeType: "model/stl", buffer: Buffer.from(squareStl()) });
  await expect(page.getByRole("button", { name: /Fill plate with square/i })).toBeVisible();
  await page.getByRole("button", { name: /Fill plate with square/i }).click();
  await expect(page.locator(".status-strip")).toContainText(/441 regular-grid copies/i);
  await expect(page.locator("svg.build-plate g.plate-part")).toHaveCount(441);

  await page.screenshot({ path: "test-results/printnest-full-bed-fill.png", fullPage: true });
});
