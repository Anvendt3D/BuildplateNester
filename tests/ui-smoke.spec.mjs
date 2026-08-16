import { expect, test } from "@playwright/test";

function squareStl(size = 10) {
  const p = [[0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0], [0, 0, size], [size, 0, size], [size, size, size], [0, size, size]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return `solid square\n${faces.map((face) => `facet normal 0 0 0\n outer loop\n${face.map((index) => `  vertex ${p[index].join(" ")}`).join("\n")}\n endloop\nendfacet`).join("\n")}\nendsolid square\n`;
}

test("PrintNest keeps the first nesting workflow clear and exposes solver-driven bed fill", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Plan a build plate" })).toBeVisible();

  const contrast = await page.locator(".controls-sidebar .panel-heading").evaluate((node) => getComputedStyle(node).color);
  expect(contrast).not.toBe("rgb(0, 0, 0)");

  const clearance = page.locator("#clearance");
  const sidebar = page.locator(".controls-sidebar");
  const sidebarScrollBefore = await sidebar.evaluate((node) => node.scrollTop);
  await clearance.hover();
  await page.mouse.wheel(0, -100);
  await expect(clearance).toHaveValue("2.1");
  await expect.poll(() => sidebar.evaluate((node) => node.scrollTop)).toBe(sidebarScrollBefore);
  await clearance.fill("2");
  await expect(clearance).toHaveValue("2");

  await page.locator('input[type="file"]').setInputFiles({ name: "square.stl", mimeType: "model/stl", buffer: Buffer.from(squareStl()) });
  await expect(page.getByText("Imported pose · ready to nest")).toBeVisible();
  await expect(page.getByText("Fill bed", { exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Quantity for square.stl" }).fill("16");
  await page.getByRole("button", { name: /Nest (on active plate|across plates|and add plates)/ }).click();
  await expect(page.locator(".status-strip")).toContainText(/Nested 16 parts/i);
  await expect(page.locator("svg.build-plate g.plate-part")).toHaveCount(16);
  await page.getByRole("button", { name: /Review orientation for square/i }).click();
  await expect(page.getByRole("heading", { name: "Click the face that should touch the plate" })).toBeVisible();
  await expect(page.getByText("BUILD PLATE · TOP SURFACE", { exact: true })).toBeVisible();
  await expect(page.getByText(/place it down immediately/i)).toBeVisible();
  await expect(page.getByText(/fixed coarse proxy/i)).toBeVisible();
  await page.screenshot({ path: "test-results/printnest-orientation-workflow.png", fullPage: true });
  await page.getByRole("button", { name: "Cancel orientation" }).click();
  await page.getByRole("button", { name: "Advanced nesting" }).click();
  await expect(page.locator("#fill-mode")).toHaveValue("remaining");
  await page.getByText("Fill bed", { exact: true }).click();
  await expect(page.getByText(/uses the nesting solver to maximize instances/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Fill bed with instances of square/i })).toBeVisible();
  await page.getByRole("complementary", { name: "Active plate controls" }).getByRole("button", { name: "Add plate" }).click();
  await expect(page.getByRole("region", { name: "Side-by-side plate workspace" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Plate 1 build plate" })).toBeVisible();

  await page.screenshot({ path: "test-results/printnest-full-bed-fill.png", fullPage: true });
});
