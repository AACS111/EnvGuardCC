"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestSimulation, type SimulationJob } from "@/detection/simulation";

export function useSimulation() {
  const [job, setJob] = useState<SimulationJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  const posting = useRef(false);
  const reading = useRef<Promise<void> | null>(null);
  const latest = useRef<SimulationJob | null>(null);
  const refresh = useCallback(() => {
    if (posting.current) return Promise.resolve();
    if (reading.current) return reading.current;
    const current = version.current;
    const operation = (async () => {
      try {
        const next = await requestSimulation();
        if (current !== version.current) return;
        latest.current = next;
        setJob(next);
        setError("");
      } catch (failure) {
        if (current === version.current) setError(failure instanceof Error ? failure.message : String(failure));
      }
    })();
    reading.current = operation;
    void operation.finally(() => { if (reading.current === operation) reading.current = null; });
    return operation;
  }, []);
  const run = useCallback(async () => {
    if (posting.current || latest.current?.running) return;
    posting.current = true;
    const current = ++version.current;
    setStarting(true);
    setError("");
    try {
      const next = await requestSimulation(true);
      if (current !== version.current) return;
      latest.current = next;
      setJob(next);
    } catch (failure) {
      if (current === version.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (current === version.current) { posting.current = false; setStarting(false); }
    }
  }, []);
  useEffect(() => {
    const reset = () => { ++version.current; posting.current = false; reading.current = null; };
    reset();
    const timer = setTimeout(() => { setStarting(false); void refresh(); }, 0);
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { reset(); clearTimeout(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  useEffect(() => {
    if (!job?.running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(() => { void poll(); }, 500); };
    timer = setTimeout(() => { void poll(); }, 250);
    return () => { stopped = true; clearTimeout(timer); };
  }, [job?.runId, job?.running, refresh]);
  return { job, error, busy: starting || job?.running === true, run, refresh };
}
