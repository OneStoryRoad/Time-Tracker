import { test, expect, Page } from "@playwright/test";
const initial = {
  schema_version: 1,
  settings: {
    business: "Your business",
    address: "",
    email: "",
    terms: "Thank you for your business. Please pay by the due date.",
    currency: "USD",
  },
  clients: [],
  entries: [],
  invoices: [],
  payments: [],
  timer: null,
  next_invoice: 1,
};
async function api(page: Page, path: string, data?: unknown) {
  return page.evaluate(
    async ({ path, data }) => {
      const r = await fetch("/api/" + path, {
        method: data ? "POST" : "GET",
        headers: data
          ? { "Content-Type": "application/json", "X-Ledger-Request": "1" }
          : {},
        body: data ? JSON.stringify(data) : undefined,
      });
      return { status: r.status, data: await r.json() };
    },
    { path, data },
  );
}
async function command(page: Page, kind: string, payload: unknown) {
  const s = await api(page, "state");
  return api(page, "command", {
    id: crypto.randomUUID(),
    version: s.data.version,
    kind,
    payload,
  });
}
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Owner password").fill("synthetic-preview-only");
  await page.getByRole("button", { name: "Open your ledger" }).click();
  await expect(
    page.getByRole("heading", { name: "Make time count." }),
  ).toBeVisible();
}
async function seed(page: Page, invoice = false) {
  await command(page, "settings", {
    business: "Synthetic Studio",
    address: "123 Example Street",
    email: "owner@example.invalid",
    terms: "Thank you for your business.",
    currency: "USD",
  });
  await command(page, "client", {
    name: "Acorn Design",
    contact: "Alex Example",
    email: "alex@example.invalid",
    address: "42 Test Avenue",
    rate: 6000,
  });
  const s = await api(page, "state");
  const cid = s.data.state.clients[0].id;
  const end = Date.now() - 10000;
  for (const [minutes, notes] of [
    [90, "Brand exploration"],
    [30, "Design review"],
  ] as const)
    await command(page, "entry", {
      client_id: cid,
      start: end - minutes * 60000,
      end,
      notes,
      billable: true,
    });
  if (invoice) {
    const s2 = await api(page, "state");
    await command(page, "invoice", {
      entry_ids: s2.data.state.entries.map((e: { id: string }) => e.id),
      issued: "2026-10-02",
      due: "2026-11-01",
    });
  }
  await page.getByRole("button", { name: "Sync ledger" }).click();
  await expect(page.getByText("Saved & synced")).toBeVisible();
  return cid;
}
const nav = (page: Page, name: string) =>
  page.locator("nav").getByRole("button", { name, exact: true }).click();
const settings = (page: Page) =>
  page
    .getByRole("button", { name: "Settings and backups", exact: true })
    .isVisible()
    .then((visible) =>
      visible
        ? page
            .getByRole("button", { name: "Settings and backups", exact: true })
            .click()
        : page
            .getByRole("button", { name: "Settings & backups", exact: true })
            .click(),
    );
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await api(page, "login", { password: "synthetic-preview-only" });
  const s = await api(page, "state");
  if (s.data.state.timer)
    await command(page, "stop", {
      timer_id: s.data.state.timer.id,
      at: Math.max(Date.now(), s.data.state.timer.start + 1),
    });
  await command(page, "restore", {
    backup: {
      format: "time-ledger-backup-v1",
      exported_at: Date.now(),
      state: initial,
      checksum: await page.evaluate(async (state) => {
        const stable = (value: unknown): unknown =>
          Array.isArray(value)
            ? value.map(stable)
            : value !== null && typeof value === "object"
              ? Object.fromEntries(
                  Object.keys(value)
                    .sort()
                    .map((key) => [
                      key,
                      stable((value as Record<string, unknown>)[key]),
                    ]),
                )
              : value;
        const hash = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(stable(state))),
        );
        return [...new Uint8Array(hash)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }, initial),
    },
  });
  await api(page, "logout", {});
  await page.reload();
});

test("complete UI: clients, exact time, $120 invoice, $25/$95 payments, PDF, backup", async ({
  page,
}, info) => {
  await login(page);
  await nav(page, "Clients");
  await page
    .getByRole("button", { name: "Add client", exact: true })
    .first()
    .click();
  await page.getByLabel("Client name").fill("Acorn Design");
  await page.getByLabel("Contact name").fill("Alex Example");
  await page.getByLabel("Email", { exact: true }).fill("alex@example.invalid");
  await page.getByLabel("Billing address").fill("42 Test Avenue\nSample City");
  await page.getByLabel("Default hourly rate").fill("60");
  await page.getByRole("button", { name: "Save client" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await settings(page);
  await page.getByLabel("Your business name").fill("Synthetic Studio");
  await page.getByRole("button", { name: "Save settings" }).click();
  await nav(page, "Time");
  for (const [start, end, note] of [
    ["2026-10-01T09:00", "2026-10-01T10:30", "Brand exploration"],
    ["2026-10-01T11:00", "2026-10-01T11:30", "Design review"],
  ]) {
    await page
      .getByRole("button", { name: "Add time", exact: true })
      .first()
      .click();
    await page.getByLabel("Start", { exact: true }).fill(start);
    await page.getByLabel("End", { exact: true }).fill(end);
    await page.getByLabel("Work notes").fill(note);
    await page.getByRole("button", { name: "Save time" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  await page
    .getByRole("checkbox", { name: "Select Brand exploration" })
    .check();
  await page.getByRole("checkbox", { name: "Select Design review" }).check();
  await page
    .getByRole("button", { name: "Create invoice", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("$120.00");
  await page.getByRole("button", { name: "Finalize invoice" }).dblclick();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect((await api(page, "state")).data.state.invoices).toHaveLength(1);
  await page.getByRole("button").filter({ hasText: "INV-00001" }).click();
  await expect(page.getByRole("dialog")).toContainText("$120.00");
  await page.getByLabel("Payment amount").fill("25");
  await page.getByRole("button", { name: "Record payment" }).dblclick();
  await expect(page.locator(".invoice-preview strong")).toHaveText("$95.00");
  expect((await api(page, "state")).data.state.payments).toHaveLength(1);
  await page.getByLabel("Payment amount").fill("95");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.locator(".invoice-preview strong")).toHaveText("$0.00");
  const pdf = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download invoice PDF" }).click();
  const d = await pdf;
  expect(d.suggestedFilename()).toBe("INV-00001.pdf");
  await d.saveAs(`evidence/${info.project.name}-ui-invoice.pdf`);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await settings(page);
  const backup = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download backup" }).click();
  const b = await backup;
  await b.saveAs(`evidence/${info.project.name}-backup.json`);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await noOverflow(page);
  await page.screenshot({
    path: `evidence/${info.project.name}-invoices.png`,
    fullPage: true,
  });
});

test("offline timer start-stop survives reload and reconnect exactly once", async ({
  page,
  context,
}) => {
  await login(page);
  await seed(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByRole("button", { name: "Start timer" })).toBeEnabled();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Start timer" }).dblclick();
  await expect(page.getByRole("button", { name: "Stop timer" })).toBeVisible();
  await expect(page.getByText("1 action saved on this device")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Stop timer" })).toBeVisible();
  await page.getByRole("button", { name: "Stop timer" }).dblclick();
  await expect(page.getByText("2 actions saved on this device")).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Sync ledger" }).click();
  await expect(page.getByText("Saved & synced")).toBeVisible();
  const s = (await api(page, "state")).data.state;
  expect(s.timer).toBeNull();
  expect(s.entries).toHaveLength(3);
  await page.reload();
  await expect(page.getByRole("button", { name: "Start timer" })).toBeVisible();
  expect((await api(page, "state")).data.state.entries).toHaveLength(3);
});

test("timer durable refresh and two-tab start/stop competition", async ({
  page,
  context,
}) => {
  await login(page);
  await seed(page);
  const p2 = await context.newPage();
  await p2.goto("/");
  await expect(p2.getByRole("button", { name: "Start timer" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start timer" })).toBeEnabled();
  await Promise.allSettled([
    page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Start timer"))
        ?.click();
    }),
    p2.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Start timer"))
        ?.click();
    }),
  ]);
  await expect
    .poll(async () => (await api(page, "state")).data.state.timer)
    .not.toBeNull();
  let s = (await api(page, "state")).data.state;
  expect(s.timer).not.toBeNull();
  const id = s.timer.id;
  await page.reload();
  await expect(page.getByRole("button", { name: "Stop timer" })).toBeVisible();
  expect((await api(page, "state")).data.state.timer.id).toBe(id);
  await p2.reload();
  await expect(p2.getByRole("button", { name: "Stop timer" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop timer" })).toBeEnabled();
  await Promise.allSettled([
    page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Stop timer"))
        ?.click();
    }),
    p2.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Stop timer"))
        ?.click();
    }),
  ]);
  await expect
    .poll(async () => (await api(page, "state")).data.state.timer)
    .toBeNull();
  s = (await api(page, "state")).data.state;
  expect(s.timer).toBeNull();
  expect(s.entries).toHaveLength(3);
  await p2.close();
});

test("lost response retains outbox and retry creates only one entry", async ({
  page,
}) => {
  await login(page);
  await seed(page);
  let dropped!: () => void;
  const completed = new Promise<void>((resolve) => {
    dropped = resolve;
  });
  await page.route("**/api/command", async (route) => {
    await route.fetch();
    await route.abort("failed");
    dropped();
  });
  await page.getByRole("button", { name: "Start timer" }).click();
  await expect(page.getByText("1 action saved on this device")).toBeVisible();
  await completed;
  await page.unroute("**/api/command");
  await page.getByRole("button", { name: "Sync ledger" }).click();
  await expect(page.getByText("Saved & synced")).toBeVisible();
  await page.getByRole("button", { name: "Stop timer" }).click();
  await expect(page.getByRole("button", { name: "Start timer" })).toBeVisible();
  expect((await api(page, "state")).data.state.entries).toHaveLength(3);
});

test("failed save shows an error, stays open, and retains recoverable pending action", async ({
  page,
}) => {
  await login(page);
  await seed(page);
  await nav(page, "Time");
  await page
    .getByRole("button", { name: "Add time", exact: true })
    .first()
    .click();
  await page.getByLabel("Start", { exact: true }).fill("2028-10-01T09:00");
  await page.getByLabel("End", { exact: true }).fill("2028-10-01T10:00");
  await page.getByRole("button", { name: "Save time" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("future");
  expect((await api(page, "state")).data.state.entries).toHaveLength(2);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByText("1 action saved on this device")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Discard queued actions & refresh" })
    .click();
  await expect(page.getByText("Saved & synced")).toBeVisible();
});

test("logout clears private cache and protects direct endpoints", async ({
  page,
}) => {
  await login(page);
  await seed(page, true);
  const i = (await api(page, "state")).data.state.invoices[0];
  await settings(page);
  await page
    .getByRole("button", { name: "Sign out & clear device cache" })
    .click();
  await expect(page.getByLabel("Owner password")).toBeVisible();
  for (const path of ["state", "backup", "export", `invoices/${i.id}/pdf`])
    expect(
      await page.evaluate(async (p) => (await fetch("/api/" + p)).status, path),
    ).toBe(401);
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const r = indexedDB.open("time-ledger", 1);
          r.onsuccess = () => {
            const q = r.result
              .transaction("cache")
              .objectStore("cache")
              .get("ledger");
            q.onsuccess = () => resolve(q.result);
          };
        }),
    ),
  ).toEqual({ snapshot: null, queue: [], projected: null });
  await page.reload();
  await expect(page.getByLabel("Owner password")).toBeVisible();
});

test("responsive pages and dialogs have no horizontal overflow", async ({
  page,
}, info) => {
  await login(page);
  await seed(page);
  for (const width of info.project.name.startsWith("iphone")
    ? [320, 390, 430]
    : [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of ["Today", "Clients", "Time", "Invoices"]) {
      await nav(page, tab);
      await noOverflow(page);
    }
    await settings(page);
    await noOverflow(page);
    await page.getByRole("button", { name: "Close dialog" }).click();
  }
  await nav(page, "Today");
  await page.screenshot({
    path: `evidence/${info.project.name}-today.png`,
    fullPage: true,
  });
  await nav(page, "Clients");
  await page.screenshot({
    path: `evidence/${info.project.name}-clients.png`,
    fullPage: true,
  });
});

test("void invoice and create linked correction without overwriting history", async ({
  page,
}) => {
  await login(page);
  await seed(page, true);
  await nav(page, "Invoices");
  await page.getByRole("button").filter({ hasText: "INV-00001" }).click();
  page.once("dialog", (d) => d.accept("Synthetic scope correction"));
  await page.getByRole("button", { name: "Void invoice", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Synthetic scope correction",
  );
  await page
    .getByRole("button", { name: "Correct time", exact: true })
    .first()
    .click();
  await page.getByLabel("Work notes").fill("Corrected design scope");
  await page.getByRole("button", { name: "Save time" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const s = (await api(page, "state")).data.state;
  expect(s.invoices[0].voided).toBeTruthy();
  expect(s.entries).toHaveLength(3);
  expect(s.entries[2].correction_of).toBeTruthy();
});

test("two tabs cannot double-record a payment and logout clears both displays", async ({
  page,
  context,
}) => {
  await login(page);
  await seed(page, true);
  await nav(page, "Invoices");
  await page.locator(".invoice-row").click();
  const p2 = await context.newPage();
  await p2.goto("/");
  await nav(p2, "Invoices");
  await p2.locator(".invoice-row").click();
  await page.getByLabel("Payment amount").fill("25");
  await p2.getByLabel("Payment amount").fill("25");
  await Promise.allSettled([
    page.getByRole("button", { name: "Record payment" }).click(),
    p2.getByRole("button", { name: "Record payment" }).click(),
  ]);
  await expect
    .poll(async () => (await api(page, "state")).data.state.payments.length)
    .toBe(1);
  const s = (await api(page, "state")).data.state;
  expect(s.payments[0].amount).toBe(2500);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await settings(page);
  await page
    .getByRole("button", { name: "Sign out & clear device cache" })
    .click();
  await expect(page.getByLabel("Owner password")).toBeVisible();
  await expect(p2.getByLabel("Owner password")).toBeVisible();
  await p2.close();
});

test("UI clean backup restore preserves payments and numbers; corruption leaves ledger unchanged", async ({
  page,
}) => {
  await login(page);
  await seed(page, true);
  const original = (await api(page, "state")).data.state;
  await command(page, "payment", {
    invoice_id: original.invoices[0].id,
    amount: 2500,
    date: "2026-10-02",
  });
  const backup = (await api(page, "backup")).data;
  await command(page, "restore", {
    backup: {
      format: backup.format,
      exported_at: Date.now(),
      state: initial,
      checksum: await page.evaluate(async (state) => {
        const sort = (v: unknown): unknown =>
          Array.isArray(v)
            ? v.map(sort)
            : v !== null && typeof v === "object"
              ? Object.fromEntries(
                  Object.keys(v)
                    .sort()
                    .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
                )
              : v;
        const h = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(sort(state))),
        );
        return [...new Uint8Array(h)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }, initial),
    },
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Make time count." }),
  ).toBeVisible();
  await settings(page);
  await page.getByRole("button", { name: "Restore a backup" }).click();
  const file = {
    name: "synthetic-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  };
  await page.getByLabel("Backup JSON file").setInputFiles(file);
  await page.getByLabel("Type REPLACE").fill("REPLACE");
  await page
    .getByRole("button", { name: "Replace ledger with backup" })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect((await api(page, "state")).data.state).toEqual(backup.state);
  await settings(page);
  await page.getByRole("button", { name: "Restore a backup" }).click();
  const bad = structuredClone(backup);
  bad.state.clients[0].name = "Checksum tamper";
  await page
    .getByLabel("Backup JSON file")
    .setInputFiles({ ...file, buffer: Buffer.from(JSON.stringify(bad)) });
  await page.getByLabel("Type REPLACE").fill("REPLACE");
  await page
    .getByRole("button", { name: "Replace ledger with backup" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("checksum");
  expect((await api(page, "state")).data.state).toEqual(backup.state);
});

test("editing notes preserves saved millisecond timestamps and historical rate", async ({
  page,
}) => {
  await login(page);
  await seed(page);
  const before = (await api(page, "state")).data.state.entries[0];
  await nav(page, "Time");
  await page
    .locator(".entry-row .row-main")
    .filter({ hasText: before.notes })
    .click();
  await page.getByLabel("Work notes").fill("Changed note only");
  await page.getByRole("button", { name: "Save time" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const after = (await api(page, "state")).data.state.entries.find(
    (e: { id: string }) => e.id === before.id,
  );
  expect(after.start).toBe(before.start);
  expect(after.end).toBe(before.end);
  expect(after.rate).toBe(before.rate);
});

test("Today clips completed work across local midnight", async ({ page }) => {
  await login(page);
  const cid = await seed(page);
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  await command(page, "entry", {
    client_id: cid,
    start: day.getTime() - 1800000,
    end: day.getTime() + 1800000,
    notes: "Cross-midnight work",
    billable: true,
  });
  await page.getByRole("button", { name: "Sync ledger" }).click();
  await expect(page.locator(".stats>div").first().locator("strong")).toHaveText(
    "02:30:00",
  );
});

test("large supported amounts remain readable at 320px", async ({ page }) => {
  await login(page);
  await command(page, "client", {
    name: "Synthetic high rate",
    rate: 100000000,
  });
  const cid = (await api(page, "state")).data.state.clients[0].id;
  const end = Date.now() - 1000;
  await command(page, "entry", {
    client_id: cid,
    start: end - 3600000,
    end,
    notes: "Amount boundary",
    billable: true,
  });
  await page.getByRole("button", { name: "Sync ledger" }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(page.locator(".stats")).toContainText("$1,000,000.00");
  await noOverflow(page);
});

test("stop atomically saves the current running note on the first tap", async ({
  page,
}) => {
  await login(page);
  await seed(page);
  await page.getByRole("button", { name: "Start timer" }).click();
  await expect(page.getByRole("button", { name: "Stop timer" })).toBeEnabled();
  await page.getByLabel("Update running note").fill("Note captured at stop");
  await page.getByRole("button", { name: "Stop timer" }).click();
  await expect
    .poll(async () => (await api(page, "state")).data.state.timer)
    .toBeNull();
  const s = (await api(page, "state")).data.state;
  expect(s.entries.at(-1).notes).toBe("Note captured at stop");
  expect(s.entries).toHaveLength(3);
});
