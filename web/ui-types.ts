import type { Client, Entry, Invoice } from "./types";
export type Modal =
  | { kind: "client"; client?: Client }
  | { kind: "entry"; entry?: Entry; correction?: Entry }
  | { kind: "settings" }
  | { kind: "invoice" }
  | { kind: "detail"; invoice: Invoice }
  | { kind: "restore" }
  | null;
