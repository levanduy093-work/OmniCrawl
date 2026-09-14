import { useI18n } from '../i18n'
import type { Locale } from '../i18n/types'

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { locale, setLocale } = useI18n()

  const toggle = () => {
    const next: Locale = locale === 'vi' ? 'en' : 'vi'
    setLocale(next)
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={locale === 'vi' ? 'Chuyển sang English' : 'Switch to Tiếng Việt'}
      className={`profile-button ${className}`}
      style={{ padding: '0 10px', fontSize: '11px', fontWeight: 600 }}
    >
      <span>{locale === 'vi' ? '🇻🇳 VI' : '🇬🇧 EN'}</span>
    </button>
  )
}
