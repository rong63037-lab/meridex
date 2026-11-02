/** Last read-only probe, in memory. Nothing here is a secret. */

export type ProbeRecord = { ok: boolean; latencyMs: number; error: string; at: number };

const probes = new Map<number, ProbeRecord>();

export function lastProbe(id: number): ProbeRecord | null {
  return probes.get(id) ?? null;
}

export function saveProbe(id: number, probe: { ok: boolean; latencyMs: number; error: string }) {
  probes.set(id, { ok: probe.ok, latencyMs: probe.latencyMs, error: probe.error, at: Date.now() });
}
