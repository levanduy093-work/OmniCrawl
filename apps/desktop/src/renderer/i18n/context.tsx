import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import type { Locale } from './types'
import { I18nContext } from './I18nContext'
import { vi } from './locales/vi'
import { en } from './locales/en'

const dictionaries = { vi, en }

const STORAGE_KEY = 'omnicrawl_desktop_locale'

function getInitialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Locale | null
    if (saved === 'vi' || saved === 'en') return saved
  } catch {}
  return 'vi'
}

function resolveNestedKey(obj: any, path: string): string | null {
  const parts = path.split('.')
  let current = obj
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return null
    }
    current = current[part]
  }
  return typeof current === 'string' ? current : null
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale)

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale)
    try {
      localStorage.setItem(STORAGE_KEY, nextLocale)
      document.documentElement.lang = nextLocale
    } catch {}
  }, [])

  useEffect(() => {
    try {
      document.documentElement.lang = locale
    } catch {}
  }, [locale])

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const activeDict = dictionaries[locale]
      const fallbackDict = dictionaries.vi

      let template = resolveNestedKey(activeDict, key)
      if (template === null) {
        template = resolveNestedKey(fallbackDict, key)
      }
      if (template === null) {
        return key
      }

      if (params) {
        return template.replace(/\{(\w+)\}/g, (match, paramKey) => {
          return params[paramKey] !== undefined ? String(params[paramKey]) : match
        })
      }

      return template
    },
    [locale]
  )

  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions): string => {
      const intlLocale = locale === 'vi' ? 'vi-VN' : 'en-US'
      return new Intl.NumberFormat(intlLocale, options).format(value)
    },
    [locale]
  )

  const formatDate = useCallback(
    (date: Date | string | number | null, options?: Intl.DateTimeFormatOptions): string => {
      if (!date) return '—'
      const dateObj = date instanceof Date ? date : new Date(date)
      if (isNaN(dateObj.getTime())) return '—'
      const intlLocale = locale === 'vi' ? 'vi-VN' : 'en-US'
      return dateObj.toLocaleString(intlLocale, options ?? { dateStyle: 'short', timeStyle: 'short' })
    },
    [locale]
  )

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t,
      formatNumber,
      formatDate
    }),
    [locale, setLocale, t, formatNumber, formatDate]
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
