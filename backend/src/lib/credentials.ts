import Anthropic from "@anthropic-ai/sdk";
import { createBrokerAdapter } from "./brokers/index.js";
import type { BrokerAdapter } from "./brokers/types.js";
import type { CredentialsStore } from "./storage/types.js";

type CredentialKey = "ANTHROPIC_API_KEY" | "DHAN_ACCESS_TOKEN" | "DHAN_CLIENT_ID";

interface CredentialsMap {
  broker?: string;
  ANTHROPIC_API_KEY?: string;
  DHAN_ACCESS_TOKEN?: string;
  DHAN_CLIENT_ID?: string;
}

interface ServiceRefs {
  heartbeat: { setBrokerAdapter(a: BrokerAdapter): void } | null;
}

class AppCredentialsStore {
  private map: CredentialsMap = {};
  private brokerAdapter: BrokerAdapter | null = null;
  private anthropicClient: Anthropic | null = null;
  private services: ServiceRefs = { heartbeat: null };
  private store: CredentialsStore | null = null;

  init(store: CredentialsStore): void {
    this.store = store;
  }

  async load(): Promise<void> {
    const envMap: CredentialsMap = {};
    if (process.env.ANTHROPIC_API_KEY) envMap.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (process.env.DHAN_ACCESS_TOKEN) envMap.DHAN_ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN;
    if (process.env.DHAN_CLIENT_ID) envMap.DHAN_CLIENT_ID = process.env.DHAN_CLIENT_ID;

    const saved = await this.store?.read();
    this.map = saved ? { ...envMap, ...(saved as CredentialsMap) } : envMap;
    this.rebuildClients();
  }

  status(): Record<CredentialKey, boolean> {
    return {
      ANTHROPIC_API_KEY: Boolean(this.map.ANTHROPIC_API_KEY),
      DHAN_ACCESS_TOKEN: Boolean(this.map.DHAN_ACCESS_TOKEN),
      DHAN_CLIENT_ID: Boolean(this.map.DHAN_CLIENT_ID),
    };
  }

  async update(patch: Partial<Record<string, string>>): Promise<void> {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && v !== "") {
        (this.map as Record<string, string>)[k] = v;
      }
    }
    await this.store?.write(this.map as Record<string, string>);
    this.rebuildClients();
    this.propagateClients();
  }

  registerServices(services: ServiceRefs): void {
    this.services = services;
  }

  getBrokerAdapter(): BrokerAdapter {
    if (!this.brokerAdapter) {
      throw new Error("Broker credentials not configured. Please set them via the Settings tab.");
    }
    return this.brokerAdapter;
  }

  getAnthropicClient(): Anthropic {
    if (!this.anthropicClient) {
      throw new Error("Anthropic API key not configured. Please set it via the Settings tab.");
    }
    return this.anthropicClient;
  }

  private rebuildClients(): void {
    if (this.map.ANTHROPIC_API_KEY) {
      this.anthropicClient = new Anthropic({ apiKey: this.map.ANTHROPIC_API_KEY });
    } else {
      this.anthropicClient = null;
    }

    const broker = this.map.broker ?? "dhan";
    if (this.map.DHAN_ACCESS_TOKEN && this.map.DHAN_CLIENT_ID) {
      try {
        this.brokerAdapter = createBrokerAdapter(broker, this.map as Record<string, string>);
      } catch {
        this.brokerAdapter = null;
      }
    } else {
      this.brokerAdapter = null;
    }
  }

  private propagateClients(): void {
    if (this.brokerAdapter) {
      this.services.heartbeat?.setBrokerAdapter(this.brokerAdapter);
    }
  }
}

export const credentialsStore = new AppCredentialsStore();
export function getBrokerAdapter(): BrokerAdapter { return credentialsStore.getBrokerAdapter(); }
export function getAnthropicClient(): Anthropic { return credentialsStore.getAnthropicClient(); }
// Backward compat alias (used in chat.ts, status.ts, approvals.ts)
export function getDhanClient(): BrokerAdapter { return credentialsStore.getBrokerAdapter(); }
