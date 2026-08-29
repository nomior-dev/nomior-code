/**
 * Minimal async-read hook for the Nomior data port.
 *
 * The port is Promise-based so the RPC implementation can slot in unchanged;
 * this hook gives panels a load/reload cycle without pulling the atom registry
 * into fixture-driven views. Rejections land in `error` (the RPC port will
 * reject on network or auth failures) so panels can show a retry state instead
 * of a permanent skeleton.
 *
 * @module nomior/usePortData
 */
import { useCallback, useEffect, useState } from "react";

export interface PortData<T> {
  readonly data: T | null;
  readonly error: Error | null;
  readonly isPending: boolean;
  readonly reload: () => void;
}

export function usePortData<T>(load: () => Promise<T>): PortData<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState(true);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsPending(true);
    setError(null);
    load().then(
      (value) => {
        if (cancelled) return;
        setData(value);
        setIsPending(false);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setIsPending(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load, generation]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { data, error, isPending, reload };
}
