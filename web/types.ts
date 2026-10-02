export type Client = {
  id: string;
  name: string;
  contact: string;
  email: string;
  address: string;
  rate: number;
  archived: boolean;
};
export type Entry = {
  id: string;
  client_id: string;
  start: number;
  end: number;
  notes: string;
  rate: number;
  billable: boolean;
  invoice_id: string | null;
  correction_of: string | null;
};
export type Timer = {
  id: string;
  client_id: string;
  start: number;
  rate: number;
  notes: string;
  billable: boolean;
};
export type Settings = {
  business: string;
  address: string;
  email: string;
  terms: string;
  currency: "USD" | "CAD" | "GBP" | "EUR" | "AUD";
};
export type Line = {
  entry_id: string;
  start: number;
  end: number;
  notes: string;
  rate: number;
  amount: number;
  correction_of: string | null;
};
export type Invoice = {
  id: string;
  number: string;
  client: Client;
  issuer: Settings;
  issued: string;
  due: string;
  lines: Line[];
  total: number;
  voided: boolean;
  void_reason: string;
  void_date: string;
};
export type Payment = {
  id: string;
  invoice_id: string;
  amount: number;
  date: string;
  reference: string;
};
export type State = {
  schema_version: 1;
  settings: Settings;
  clients: Client[];
  entries: Entry[];
  invoices: Invoice[];
  payments: Payment[];
  timer: Timer | null;
  next_invoice: number;
};
export type Snapshot = { version: number; state: State; server_now: number };
export type Command = {
  id: string;
  version: number;
  kind: string;
  payload: Record<string, unknown>;
};
export const cents = (value: string) => {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value))
    throw Error("Enter a positive amount with at most two decimal places.");
  const [whole, part = ""] = value.split(".");
  const n = Number(whole) * 100 + Number(part.padEnd(2, "0"));
  if (n > 100000000) throw Error("Amount is too large.");
  return n;
};
export const amount = (e: Entry) =>
  Number((BigInt(e.end - e.start) * BigInt(e.rate) + 1800000n) / 3600000n);
export const money = (value: number, currency = "USD") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    value / 100,
  );
export const duration = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 3600)
    .toString()
    .padStart(2, "0")}:${Math.floor((sec / 60) % 60)
    .toString()
    .padStart(2, "0")}:${(sec % 60).toString().padStart(2, "0")}`;
};
export const localDate = (timestamp = Date.now()) => {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const localInput = (timestamp: number) => {
  const d = new Date(timestamp);
  return `${localDate(timestamp)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};
