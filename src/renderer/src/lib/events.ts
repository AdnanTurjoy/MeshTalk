import { useEffect, useRef } from 'react';
import type { AppEvent, AppEventType } from '../../../shared/events';

/** Subscribes to main-process events of the given types for the component's lifetime. */
export function useAppEvent(
  types: readonly AppEventType[],
  handler: (event: AppEvent) => void,
): void {
  const handlerRef = useRef(handler);
  const key = types.join(',');
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    const wanted = new Set(key.split(','));
    return window.meshtalk.onEvent((event) => {
      if (wanted.has(event.type)) handlerRef.current(event);
    });
  }, [key]);
}
