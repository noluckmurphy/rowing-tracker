/**
 * Storage adapter.
 * - In Claude artifact environment: uses window.storage (persistent cross-session KV)
 * - Locally / deployed: falls back to localStorage
 */

const isClaudeEnv = typeof window !== 'undefined' && typeof window.storage?.get === 'function'

export const storage = {
  async get(key) {
    if (isClaudeEnv) {
      try {
        const result = await window.storage.get(key)
        return result ? result.value : null
      } catch {
        return null
      }
    }
    return localStorage.getItem(key)
  },

  async set(key, value) {
    if (isClaudeEnv) {
      try {
        await window.storage.set(key, value)
      } catch (e) {
        console.error('Claude storage write failed:', e)
      }
    } else {
      localStorage.setItem(key, value)
    }
  },

  async remove(key) {
    if (isClaudeEnv) {
      try { await window.storage.delete(key) } catch {}
    } else {
      localStorage.removeItem(key)
    }
  }
}
