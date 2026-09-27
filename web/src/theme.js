// Color theme: dark (the default), light, or following the system. The choice is kept in
// localStorage; index.html applies it before the first paint so the page never flashes.
import { useSyncExternalStore } from 'react';

export const THEMES = ['dark', 'light', 'system'];
const STORAGE_KEY = 'gp_theme';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

function saved() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (THEMES.includes(v)) return v;
  } catch {}
  return 'dark';
}

let pref = saved();
const listeners = new Set();

const resolved = () => (pref === 'system' ? (media?.matches ? 'light' : 'dark') : pref);

function apply() {
  const t = resolved();
  const root = document.documentElement;
  root.dataset.theme = t;
  root.style.colorScheme = t;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f5f6f8' : '#0e0f13');
}

// Following the system: an OS switch applies at once
media?.addEventListener?.('change', () => {
  if (pref !== 'system') return;
  apply();
  for (const fn of listeners) fn();
});

apply();

export const getTheme = () => pref;

export function setTheme(value) {
  if (!THEMES.includes(value) || value === pref) return;
  pref = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {}
  apply();
  for (const fn of listeners) fn();
}

export function useTheme() {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, getTheme);
}
