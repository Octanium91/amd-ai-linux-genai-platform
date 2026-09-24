import { getLang, LANGS, setLang } from './i18n.js';

export function LangSwitch() {
  return (
    <select className="lang-switch" value={getLang()} onChange={(e) => setLang(e.target.value)} aria-label="Language">
      {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
    </select>
  );
}
