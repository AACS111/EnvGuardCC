// A local treatment goal is separate from measured observations and executable settings.
type TargetStorage = Pick<Storage, "getItem" | "setItem">;
export type RepairTarget = { id: string; value: string; label: string };
const targetKey = (signalId: string) => `checkcc.repair-target.v1.${signalId}`;

export function readRepairTarget(storage: TargetStorage, signalId: string) {
  return storage.getItem(targetKey(signalId));
}

export function decodeRepairTarget(snapshot: string | null): RepairTarget | null {
  try {
    const target = JSON.parse(snapshot ?? "null");
    return target && typeof target.id === "string" && typeof target.value === "string" && typeof target.label === "string" ? target : null;
  } catch { return null; }
}

export function saveRepairTarget(storage: TargetStorage, signalId: string, target: RepairTarget) {
  storage.setItem(targetKey(signalId), JSON.stringify({ id: target.id, value: target.value, label: target.label }));
}
