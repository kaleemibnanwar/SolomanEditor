/**
 * Minimal store core with a zustand-compatible API, built on React's
 * useSyncExternalStore so the app needs no extra dependency.
 *
 *   const store = createStore<State>((set, get) => ({ ... }))
 *   store.getState() / store.setState(...) / store.subscribe(fn)
 *   const n = useStore(store, (s) => s.count)
 */
import { useCallback, useRef, useSyncExternalStore } from "react";

export type SetState<T> = (
  partial: Partial<T> | ((state: T) => Partial<T> | void),
  replace?: boolean,
) => void;

export type GetState<T> = () => T;

export interface StoreApi<T> {
  getState: GetState<T>;
  setState: SetState<T>;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T extends object>(
  initializer: (set: SetState<T>, get: GetState<T>) => T,
): StoreApi<T> {
  let state: T;
  const listeners = new Set<() => void>();

  const setState: SetState<T> = (partial) => {
    const next = typeof partial === "function" ? (partial as (s: T) => Partial<T> | void)(state) : partial;
    if (!next) return;
    const merged = { ...state, ...next } as T;
    if (shallowEqual(state, merged)) return;
    state = merged;
    listeners.forEach((l) => l());
  };

  const getState: GetState<T> = () => state;

  const api: StoreApi<T> = {
    getState,
    setState,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  state = initializer(setState, getState);
  return api;
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

export function shallowArrayEqual<T>(a: T[], b: T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * Subscribe to a slice of the store. The selector result is cached so
 * object/array returning selectors don't cause render loops.
 */
export function useStore<T extends object, S>(
  store: StoreApi<T>,
  selector: (state: T) => S,
  isEqual: (a: S, b: S) => boolean = Object.is,
): S {
  const cache = useRef<{ state: T; value: S; selector: (s: T) => S } | null>(null);
  const selectorRef = useRef(selector);
  if (selectorRef.current !== selector) selectorRef.current = selector;

  const getSnapshot = useCallback(() => {
    const state = store.getState();
    const prev = cache.current;
    const sel = selectorRef.current;
    if (prev && prev.state === state && prev.selector === sel) return prev.value;
    const value = sel(state);
    if (prev && isEqual(prev.value, value)) {
      cache.current = { state, value: prev.value, selector: sel };
      return prev.value;
    }
    cache.current = { state, value, selector: sel };
    return value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, isEqual]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
