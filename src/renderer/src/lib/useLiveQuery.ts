import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppEventType } from '../../../shared/events';
import { errorMessage } from './api';
import { useAppEvent } from './events';

export type QueryState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: string };

/**
 * Loads data from main and reloads it whenever one of `refreshOn` fires or a
 * value in `deps` changes. Keeps the previous data visible while refreshing.
 */
export function useLiveQuery<T>(
  fetcher: () => Promise<T>,
  refreshOn: readonly AppEventType[] = [],
  deps: readonly unknown[] = [],
) {
  const depsKey = JSON.stringify(deps);
  const [state, setState] = useState<QueryState<T>>({ status: 'loading', data: null, error: null });
  const fetcherRef = useRef(fetcher);
  const generation = useRef(0);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const run = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const data = await fetcherRef.current();
      if (gen === generation.current) setState({ status: 'ready', data, error: null });
    } catch (error) {
      if (gen === generation.current) {
        setState((prev) => ({ status: 'error', data: prev.data, error: errorMessage(error) }));
      }
    }
  }, []);

  useEffect(() => {
    const gen = generation;
    void run();
    // Ignore responses that arrive after unmount.
    return () => {
      gen.current++;
    };
  }, [run, depsKey]);

  useAppEvent(refreshOn, () => void run());

  return { ...state, reload: run };
}
