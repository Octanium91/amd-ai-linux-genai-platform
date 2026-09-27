import { setTheme, useTheme } from './theme.js';
import { t } from './i18n.js';

export function ThemeSwitch() {
  const theme = useTheme();
  return (
    <select className="lang-switch" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label={t('Theme')}>
      <option value="dark">{t('Dark')}</option>
      <option value="light">{t('Light')}</option>
      <option value="system">{t('System')}</option>
    </select>
  );
}
