import { test, expect } from "@playwright/test";

// Login page: show/hide password on both forms, confirm password on create account.
// No account is created: the mismatch case stops before Supabase is called.

test("sign in password can be shown and hidden", async ({ page }) => {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  const password = page.getByPlaceholder("Password");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide password" }).click();
  await expect(password).toHaveAttribute("type", "password");
  await expect(page.getByPlaceholder("Confirm password")).toHaveCount(0);
});

test("create account has a confirm field, eye toggles and a mismatch message", async ({ page }) => {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New here? Create an account" }).click();

  const password = page.getByPlaceholder("Password", { exact: true });
  const confirm = page.getByPlaceholder("Confirm password");
  await expect(confirm).toBeVisible();
  await page.getByRole("button", { name: "Show password" }).nth(1).click();
  await expect(confirm).toHaveAttribute("type", "text");
  await expect(password).toHaveAttribute("type", "password");

  await page.getByPlaceholder("Email").fill("mismatch@example.com");
  await password.fill("secret1");
  await confirm.fill("secret2");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Passwords do not match.")).toBeVisible();

  await page.getByRole("button", { name: "Have an account? Sign in" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText("Passwords do not match.")).toHaveCount(0);
});
