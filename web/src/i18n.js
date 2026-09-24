// Minimal gettext-style i18n: the English text is the key, uk/ru dictionaries hold translations.
// A missing translation falls back to English. Parameters use {name} placeholders.
import { useSyncExternalStore } from 'react';
import uk from './locales/uk.js';
import ru from './locales/ru.js';

export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'uk', label: 'Українська' },
  { code: 'ru', label: 'Русский' },
];
const DICTS = { en: {}, uk, ru };
const LOCALES = { en: 'en-GB', uk: 'uk-UA', ru: 'ru-RU' };
const STORAGE_KEY = 'gp_lang';

function initialLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && DICTS[saved]) return saved;
  } catch {}
  return 'en'; // English is the default regardless of the browser language
}

let lang = initialLang();
const listeners = new Set();
document.documentElement.lang = lang;

export const getLang = () => lang;
export const dateLocale = () => LOCALES[lang];

export function setLang(code) {
  if (!DICTS[code] || code === lang) return;
  lang = code;
  document.documentElement.lang = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {}
  for (const fn of listeners) fn();
}

// Re-renders the calling component (the app root) when the language changes
export function useLang() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => lang,
  );
}

export function t(key, params) {
  let s = DICTS[lang]?.[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? params[k] : m));
  return s;
}

// Localized catalog field: entry.i18n[lang][field] when present, otherwise the English field
export function loc(entry, field) {
  return entry?.i18n?.[lang]?.[field] ?? entry?.[field];
}

// Server errors are plain English; translate them when the dictionary knows the text.
// Messages with a variable tail ("Models not downloaded: …") are matched by their prefix.
export function tError(message) {
  const d = DICTS[lang];
  if (!message || !d) return message;
  if (d[message]) return d[message];
  const i = message.indexOf(': ');
  if (i > 0 && d[message.slice(0, i + 1)]) return d[message.slice(0, i + 1)] + message.slice(i + 1);
  return message;
}
