import type { Command, Snapshot, State } from "./types";
// One atomic IndexedDB record contains both durable confirmed state and outbox.
export type Cache = {
  snapshot: Snapshot | null;
  queue: Command[];
  projected: State | null;
};
const db = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("time-ledger", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("cache");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
export async function readCache(): Promise<Cache> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("cache");
    const r = tx.objectStore("cache").get("ledger");
    r.onsuccess = () =>
      resolve(r.result ?? { snapshot: null, queue: [], projected: null });
    r.onerror = () => reject(r.error);
    tx.oncomplete = () => d.close();
  });
}
export async function saveCache(c: Cache) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = d.transaction("cache", "readwrite");
    tx.objectStore("cache").put(c, "ledger");
    tx.oncomplete = () => {
      d.close();
      resolve();
    };
    tx.onerror = () => {
      d.close();
      reject(tx.error);
    };
  });
}
export async function api(path: string, body?: unknown) {
  const response = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers: body
      ? { "Content-Type": "application/json", "X-Ledger-Request": "1" }
      : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    let detail = await response.text();
    try {
      detail = JSON.parse(detail).detail;
    } catch {
      /* plain response */
    }
    throw new ApiError(detail, response.status);
  }
  return response.json();
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export function project(s: State, cmd: Command): State {
  const n = structuredClone(s),
    p = cmd.payload;
  const at = p.at as number;
  if (cmd.kind === "start") {
    n.timer = {
      id: "pending-" + cmd.id,
      client_id: p.client_id as string,
      start: at,
      notes: p.notes as string,
      rate: n.clients.find((c) => c.id === p.client_id)!.rate,
      billable: p.billable as boolean,
    };
  } else if (cmd.kind === "stop" || cmd.kind === "switch") {
    if (n.timer) {
      n.entries.push({
        ...n.timer,
        notes: (p.stop_notes as string) ?? n.timer.notes,
        end: at,
        invoice_id: null,
        correction_of: null,
      });
      n.timer = null;
    }
    if (cmd.kind === "switch")
      n.timer = {
        id: "pending-" + cmd.id,
        client_id: p.client_id as string,
        start: at,
        notes: p.notes as string,
        rate: n.clients.find((c) => c.id === p.client_id)!.rate,
        billable: p.billable as boolean,
      };
  } else if (cmd.kind === "timer_notes" && n.timer)
    n.timer.notes = p.notes as string;
  else if (cmd.kind === "entry") {
    const old = n.entries.find((e) => e.id === p.id);
    const e = {
      ...p,
      id: (p.id as string) || "pending-" + cmd.id,
      rate:
        (p.rate as number) ??
        old?.rate ??
        n.clients.find((c) => c.id === p.client_id)!.rate,
      invoice_id: null,
      correction_of: p.correction_of ?? old?.correction_of ?? null,
    } as unknown as State["entries"][number];
    n.entries = n.entries.filter((x) => x.id !== e.id);
    n.entries.push(e);
  }
  return n;
}
