import type { ManagedAgentProvider } from "@brooswit/drovr";

export const DEFAULT_PROVIDER_ORDER: readonly ManagedAgentProvider[] = ["agy", "codex", "claude"];

export function providerOrder(value = process.env["USRR_AGENT_PROVIDERS"]): ManagedAgentProvider[] {
  if (value === undefined) return [...DEFAULT_PROVIDER_ORDER];
  const entries = value.split(",").map(entry => entry.trim());
  if (entries.some(entry => entry !== "agy" && entry !== "codex" && entry !== "claude") || new Set(entries).size !== entries.length) {
    throw new Error("USRR_AGENT_PROVIDERS must be an ordered list of distinct agy, codex, claude providers");
  }
  return entries as ManagedAgentProvider[];
}
