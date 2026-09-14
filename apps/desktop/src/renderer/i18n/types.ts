export type Locale = 'vi' | 'en'

export interface I18nContextType {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, params?: Record<string, string | number>) => string
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string
  formatDate: (date: Date | string | number | null, options?: Intl.DateTimeFormatOptions) => string
}
