type Entry = { data: any; expires: number }
const store = new Map<string, Entry>()

export function getCache<T>(key: string): T | null {
  const entry = store.get(key)
  if (!entry) return null
  if (Date.now() > entry.expires) { store.delete(key); return null }
  return entry.data as T
}

export function setCache(key: string, data: any, ttlMs = 5 * 60 * 1000) {
  store.set(key, { data, expires: Date.now() + ttlMs })
}

export function invalidateCache(prefix: string) {
  for (const key of store.keys())
    if (key.startsWith(prefix)) store.delete(key)
}
