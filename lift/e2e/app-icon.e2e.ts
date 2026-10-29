import { test, expect } from "@playwright/test";

// App icon (dumbbell) is served as a PNG at every size the manifest and iOS use.

for (const size of [180, 192, 512]) {
  test(`icon ${size} renders as a png`, async ({ request }) => {
    const res = await request.get(`/icons/${size}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    const body = await res.body();
    expect(body.subarray(1, 4).toString()).toBe("PNG");
    expect(body.length).toBeGreaterThan(500);
  });
}

test("favicon renders as a png", async ({ request }) => {
  const res = await request.get("/icon");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/png");
});

test("manifest still points at the 192 and 512 icons", async ({ request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  const srcs = manifest.icons.map((i: { src: string }) => i.src);
  expect(srcs).toEqual(expect.arrayContaining(["/icons/192", "/icons/512"]));
});
