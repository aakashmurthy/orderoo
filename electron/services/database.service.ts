/**
 * Database Service
 * Provides a clean abstraction over the database with proper error handling.
 * Data is stored as plain JSON so users can read it directly.
 */

import { app } from 'electron'
import path from 'node:path'
import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'
import type { Account, Order, Data } from '../types'

const defaultData: Data = { orders: [], accounts: [] }

/**
 * Simple mutex for preventing concurrent write operations
 */
class Mutex {
  private locked = false
  private queue: (() => void)[] = []

  async acquire(): Promise<() => void> {
    return new Promise(resolve => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true
          resolve(() => this.release())
        } else {
          this.queue.push(tryAcquire)
        }
      }
      tryAcquire()
    })
  }

  private release(): void {
    this.locked = false
    const next = this.queue.shift()
    if (next) next()
  }
}

/**
 * Database Service Class
 * Singleton pattern to ensure single database instance.
 * Stores data as plain JSON — readable without any special tools.
 */
class DatabaseService {
  private db: Low<Data> | null = null
  private initialized = false
  private writeLock = new Mutex()

  /**
   * Initialize the database.
   * In development: stores storage.json in project root.
   * In production: stores storage.json in the userData directory.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    const file = app.isPackaged
      ? path.join(app.getPath('userData'), 'storage.json')
      : path.join(process.cwd(), 'storage.json')

    const adapter = new JSONFile<Data>(file)
    this.db = new Low<Data>(adapter, defaultData)

    await this.db.read()
    this.db.data ||= defaultData
    await this.db.write()

    this.initialized = true
    console.log(`[Database] Storage file: ${file}`)
  }

  private ensureInitialized(): Low<Data> {
    if (!this.db || !this.initialized) {
      throw new Error('Database not initialized. Call initialize() first.')
    }
    return this.db
  }

  // Account Operations
  async getAccounts(): Promise<Account[]> {
    const db = this.ensureInitialized()
    await db.read()
    return db.data.accounts
  }

  async addAccount(account: Account): Promise<boolean> {
    const release = await this.writeLock.acquire()
    try {
      const db = this.ensureInitialized()
      await db.read()

      const exists = db.data.accounts.some(a => a.email === account.email)
      if (exists) {
        throw new Error('Account with this email already exists')
      }

      db.data = { ...db.data, accounts: [...db.data.accounts, account] }
      await db.write()
      return true
    } finally {
      release()
    }
  }

  async updateAccount(account: Account): Promise<boolean> {
    const release = await this.writeLock.acquire()
    try {
      const db = this.ensureInitialized()
      await db.read()

      const index = db.data.accounts.findIndex(a => a.id === account.id)
      if (index === -1) {
        throw new Error('Account not found')
      }

      const existing = db.data.accounts[index]
      const updatedAccount = {
        ...existing,
        ...account,
        status: 'ok' as const
      }

      db.data = {
        ...db.data,
        accounts: db.data.accounts.map((a, i) => i === index ? updatedAccount : a)
      }

      await db.write()
      return true
    } finally {
      release()
    }
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    const release = await this.writeLock.acquire()
    try {
      const db = this.ensureInitialized()
      await db.read()

      const index = db.data.accounts.findIndex(a => a.id === accountId)
      if (index === -1) {
        throw new Error('Account not found')
      }

      db.data = { ...db.data, accounts: db.data.accounts.filter(a => a.id !== accountId) }
      await db.write()
      return true
    } finally {
      release()
    }
  }

  async markAccountAuthError(accountId: string): Promise<void> {
    const release = await this.writeLock.acquire()
    try {
      const db = this.ensureInitialized()
      await db.read()

      const index = db.data.accounts.findIndex(a => a.id === accountId)
      if (index !== -1) {
        db.data = {
          ...db.data,
          accounts: db.data.accounts.map((a, i) =>
            i === index ? { ...a, status: 'auth_error' as const } : a
          )
        }
        await db.write()
      }
    } finally {
      release()
    }
  }

  // Order Operations
  async getOrders(): Promise<Order[]> {
    const db = this.ensureInitialized()
    await db.read()
    return db.data.orders
  }

  async getOrderById(orderId: string): Promise<Order | null> {
    const db = this.ensureInitialized()
    await db.read()
    return db.data.orders.find(o => o.id === orderId) || null
  }

  async upsertOrder(order: Order): Promise<void> {
    const release = await this.writeLock.acquire()
    try {
      const db = this.ensureInitialized()
      await db.read()

      const index = db.data.orders.findIndex(o => o.id === order.id)
      if (index !== -1) {
        const existing = db.data.orders[index]
        const mergedEmailIds = [...new Set([
          ...(existing.emailIds || []),
          ...(order.emailIds || [])
        ])]

        const updatedOrder = {
          ...existing,
          ...order,
          items: mergeItems(existing.items, order.items),
          total: order.total > 0 ? order.total : existing.total,
          status: existing.status === 'cancelled' || order.status === 'cancelled' ? 'cancelled' as const : order.status,
          emailIds: mergedEmailIds,
          accountId: existing.accountId || order.accountId
        }
        db.data = {
          ...db.data,
          orders: db.data.orders.map((o, i) => i === index ? updatedOrder : o)
        }
      } else {
        db.data = { ...db.data, orders: [...db.data.orders, order] }
      }

      await db.write()
    } finally {
      release()
    }
  }

  async upsertOrders(orders: Order[]): Promise<void> {
    const release = await this.writeLock.acquire()
    try {
      const db = this.ensureInitialized()
      await db.read()

      let currentOrders = [...db.data.orders]

      for (const order of orders) {
        const index = currentOrders.findIndex(o => o.id === order.id)
        if (index !== -1) {
          const existing = currentOrders[index]
          const mergedEmailIds = [...new Set([
            ...(existing.emailIds || []),
            ...(order.emailIds || [])
          ])]
          const updatedOrder = {
            ...existing,
            ...order,
            items: mergeItems(existing.items, order.items),
            total: order.total > 0 ? order.total : existing.total,
            status: existing.status === 'cancelled' || order.status === 'cancelled' ? 'cancelled' as const : order.status,
            emailIds: mergedEmailIds,
            accountId: existing.accountId || order.accountId
          }
          currentOrders = currentOrders.map((o, i) => i === index ? updatedOrder : o)
        } else {
          currentOrders = [...currentOrders, order]
        }
      }

      db.data = { ...db.data, orders: currentOrders }
      await db.write()
    } finally {
      release()
    }
  }

  async clearOrders(): Promise<void> {
    const release = await this.writeLock.acquire()
    try {
      const db = this.ensureInitialized()
      await db.read()
      db.data = { ...db.data, orders: [] }
      await db.write()
    } finally {
      release()
    }
  }

  /**
   * Get raw database access (use sparingly)
   */
  getRawDb(): Low<Data> {
    return this.ensureInitialized()
  }
}

/**
 * Check if an image is a real product image (not placeholder)
 */
function isRealImage(image: string | undefined): boolean {
  return !!image && !image.includes('unknown-product')
}

/**
 * Calculate a quality score for an items array
 */
function calculateItemsQuality(items: Order['items']): number {
  if (items.length === 0) return 0

  let score = 0
  for (const item of items) {
    if (item.name === 'Unknown Product') {
      score -= 10
    } else {
      score += Math.min(item.name.length, 50)
    }

    if (isRealImage(item.image)) {
      score += 20
    }

    if (item.price > 0) {
      score += 10
    }
  }

  return score
}

/**
 * Merge two items arrays, keeping the best attributes from each
 */
function mergeItems(existing: Order['items'], incoming: Order['items']): Order['items'] {
  if (existing.length === 0) return incoming
  if (incoming.length === 0) return existing

  const existingQuality = calculateItemsQuality(existing)
  const incomingQuality = calculateItemsQuality(incoming)

  const base = incomingQuality >= existingQuality ? incoming : existing
  const other = incomingQuality >= existingQuality ? existing : incoming

  if (base.length === other.length) {
    return base.map((item, i) => {
      const otherItem = other[i]
      if (!isRealImage(item.image) && isRealImage(otherItem?.image)) {
        return { ...item, image: otherItem.image }
      }
      return item
    })
  }

  const baseHasNoRealImages = base.every(item => !isRealImage(item.image))
  const otherHasRealImages = other.some(item => isRealImage(item.image))

  if (baseHasNoRealImages && otherHasRealImages) {
    const realImage = other.find(item => isRealImage(item.image))?.image
    if (realImage) {
      return base.map(item => ({ ...item, image: realImage }))
    }
  }

  return base
}

// Export singleton instance
export const databaseService = new DatabaseService()
