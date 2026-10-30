"use client";

import { useMemo, useSyncExternalStore } from "react";
import { decodeRepairTarget, readRepairTarget } from "./repair-target";

const targetChange = "checkcc-repair-target-change";
const emptyTarget = () => null;

export function subscribeRepairTargets(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(targetChange, listener);
  return () => { window.removeEventListener("storage", listener); window.removeEventListener(targetChange, listener); };
}

export function notifyRepairTargetChange() {
  window.dispatchEvent(new Event(targetChange));
}

export function useRepairTarget(signalId: string) {
  const snapshot = useSyncExternalStore(subscribeRepairTargets, () => {
    try { return readRepairTarget(window.localStorage, signalId); } catch { return null; }
  }, emptyTarget);
  return useMemo(() => decodeRepairTarget(snapshot), [snapshot]);
}
