interface CacheEntry {
  data: any
  expiresAt: number
}

class MemoryCache {
  private store = new Map<string, CacheEntry>()
  private TTL = 30 * 60 * 1000 // 30 minutos

  get(key: string) {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }
    return entry.data
  }

  set(key: string, data: any, ttlMs?: number) {
    this.store.set(key, { data, expiresAt: Date.now() + (ttlMs || this.TTL) })
  }
}

export const cache = new MemoryCache()
