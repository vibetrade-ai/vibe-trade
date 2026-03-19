import type { BrokerAdapter } from "./types.js";
import { DhanAdapter } from "./dhan/index.js";

export function createBrokerAdapter(
  broker: string,
  credentials: Record<string, string>
): BrokerAdapter {
  if (broker === "dhan") {
    return new DhanAdapter(credentials.DHAN_ACCESS_TOKEN, credentials.DHAN_CLIENT_ID);
  }
  throw new Error(`Unknown broker: "${broker}". Add an adapter in src/lib/brokers/${broker}/`);
}

export type { BrokerAdapter } from "./types.js";
export { BrokerError, BrokerAuthError } from "./errors.js";
