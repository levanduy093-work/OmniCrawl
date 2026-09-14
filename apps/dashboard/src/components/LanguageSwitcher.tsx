import { useI18n, type Locale } from '../i18n'
import { Globe } from 'lucide-react'

interface LanguageSwitcherProps {
  variant?: 'toggle' | 'select' | 'compact'
  className?: string
}

export default function LanguageSwitcher({ variant = 'toggle', className = '' }: LanguageSwitcherProps) {
  const { locale, setLocale } = useI18n()

  if (variant === 'select') {
    return (
      <div className={`flex items-center gap-3 ${className}`}>
        <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
          <Globe size={16} className="text-gray-500" />
        </label>
        <div className="flex bg-gray-100 p-1 rounded-xl border border-gray-200">
          <button
            type="button"
            onClick={() => setLocale('vi')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              locale === 'vi'
                ? 'bg-white text-blue-600 shadow-xs'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            🇻🇳 Tiếng Việt
          </button>
          <button
            type="button"
            onClick={() => setLocale('en')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              locale === 'en'
                ? 'bg-white text-blue-600 shadow-xs'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            🇬🇧 English
          </button>
        </div>
      </div>
    )
  }

  const toggleLanguage = () => {
    const nextLocale: Locale = locale === 'vi' ? 'en' : 'vi'
    setLocale(nextLocale)
  }

  return (
    <button
      type="button"
      onClick={toggleLanguage}
      title={locale === 'vi' ? 'Chuyển sang English' : 'Switch to Tiếng Việt'}
      className={`relative inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-gray-200/80 bg-white/90 hover:bg-gray-50 text-xs font-medium text-gray-700 shadow-2xs transition-all cursor-pointer select-none active:scale-95 ${className}`}
    >
      <Globe size={14} className="text-blue-500" />
      <span className="font-semibold text-[11px] uppercase tracking-wider">
        {locale === 'vi' ? '🇻🇳 VI' : '🇬🇧 EN'}
      </span>
    </button>
  )
}
