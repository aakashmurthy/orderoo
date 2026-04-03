/**
 * IPC Handlers
 * Centralized IPC handler registration with proper error handling and validation
 *
 * Security features:
 * - Input validation on all handlers
 * - Error message sanitization (no stack traces or internal paths)
 * - Rate limiting on scrape operations
 */

import { ipcMain } from 'electron'
import type { Account } from '../types'
import { IpcChannels } from '../types'
import { databaseService } from '../services/database.service'
import { scrapeAllAccounts } from '../services/scraper.service'
import { fetchEmailsByUids, testConnection } from '../imap'

/**
 * Email format validation regex (RFC 5322 simplified)
 * More robust than basic regex - validates domain structure properly
 */
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/

const SCRAPE_COOLDOWN_MS = 30000 // 30 seconds between scrapes

/**
 * Sanitize error messages before sending to renderer
 * Removes stack traces and internal paths that could leak implementation details
 */
function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    // Remove stack traces and file paths
    let message = error.message
    // Remove any "at ..." stack trace lines
    message = message.replace(/\s+at\s+.*/g, '')
    // Remove file paths (both Windows and Unix style)
    message = message.replace(/[A-Za-z]:\\[^\s:]+/g, '[path]')
    message = message.replace(/\/[^\s:]+\/[^\s:]+/g, '[path]')
    return message.trim() || 'An error occurred'
  }
  if (typeof error === 'string') {
    return error
  }
  return 'An unexpected error occurred'
}

/**
 * Validate account data before processing
 * @param account - The account data to validate
 * @param requirePassword - Whether password is required (true for new accounts)
 */
function validateAccount(account: unknown, requirePassword = false): account is Account {
  if (!account || typeof account !== 'object') {
    throw new Error('Invalid account data')
  }

  const acc = account as Record<string, unknown>

  if (!acc.id || typeof acc.id !== 'string') {
    throw new Error('Account ID is required')
  }

  if (!acc.email || typeof acc.email !== 'string') {
    throw new Error('Account email is required')
  }

  // Validate email format
  if (!EMAIL_REGEX.test(acc.email)) {
    throw new Error('Invalid email format')
  }

  if (!acc.provider || !['icloud', 'gmail', 'custom'].includes(acc.provider as string)) {
    throw new Error('Invalid account provider')
  }

  // Password is required for new accounts
  if (requirePassword) {
    if (!acc.password || typeof acc.password !== 'string' || acc.password.trim() === '') {
      throw new Error('Account password is required')
    }
  }

  return true
}

/**
 * Validate account ID
 */
function validateAccountId(id: unknown): id is string {
  if (!id || typeof id !== 'string') {
    throw new Error('Valid account ID is required')
  }
  return true
}

/**
 * Validate date filter
 */
function validateDateFilter(dateFilter: unknown): dateFilter is string | undefined {
  if (dateFilter !== undefined && typeof dateFilter !== 'string') {
    throw new Error('Date filter must be a string')
  }
  return true
}

/**
 * Wrapper for async IPC handlers with error handling
 * Security: Sanitizes error messages before sending to renderer
 */
function handleAsync<T = unknown>(
  handler: (...args: unknown[]) => Promise<T>
) {
  return async (_event: Electron.IpcMainInvokeEvent, ...args: unknown[]): Promise<T> => {
    try {
      return await handler(...args)
    } catch (error) {
      // Log the full error internally for debugging
      console.error('IPC Handler Error:', error)
      // Throw a sanitized error to the renderer (no stack traces or paths)
      throw new Error(sanitizeError(error))
    }
  }
}

/**
 * Register all IPC handlers
 * Should be called once at application startup
 */
export function registerIpcHandlers(): void {
  // Rate limiting state scoped to handler lifecycle
  let lastScrapeTime = 0

  // Account Operations
  ipcMain.handle(
    IpcChannels.GET_ACCOUNTS,
    handleAsync(async () => {
      return await databaseService.getAccounts()
    })
  )

  ipcMain.handle(
    IpcChannels.ADD_ACCOUNT,
    handleAsync(async (account: unknown) => {
      if (!validateAccount(account, true)) return false // Require password for new accounts
      return await databaseService.addAccount(account)
    })
  )

  ipcMain.handle(
    IpcChannels.UPDATE_ACCOUNT,
    handleAsync(async (account: unknown) => {
      if (!validateAccount(account)) return false
      return await databaseService.updateAccount(account)
    })
  )

  ipcMain.handle(
    IpcChannels.DELETE_ACCOUNT,
    handleAsync(async (accountId: unknown) => {
      if (!validateAccountId(accountId)) return false
      return await databaseService.deleteAccount(accountId)
    })
  )

  ipcMain.handle(
    IpcChannels.TEST_CONNECTION,
    handleAsync(async (account: unknown) => {
      if (!validateAccount(account, true)) return { success: false, error: 'Invalid account data' } // Require password for connection test
      return await testConnection(account)
    })
  )

  // Order Operations
  ipcMain.handle(
    IpcChannels.GET_ORDERS,
    handleAsync(async () => {
      return await databaseService.getOrders()
    })
  )

  ipcMain.handle(
    IpcChannels.SCRAPE_ALL,
    handleAsync(async (dateFilter: unknown) => {
      if (!validateDateFilter(dateFilter)) return []

      // Rate limiting: prevent scraping too frequently
      const now = Date.now()
      const timeSinceLastScrape = now - lastScrapeTime
      if (lastScrapeTime > 0 && timeSinceLastScrape < SCRAPE_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((SCRAPE_COOLDOWN_MS - timeSinceLastScrape) / 1000)
        throw new Error(`Please wait ${waitSeconds} seconds before scraping again`)
      }

      lastScrapeTime = now
      return await scrapeAllAccounts(dateFilter)
    })
  )

  ipcMain.handle(
    IpcChannels.CLEAR_ORDERS,
    handleAsync(async () => {
      await databaseService.clearOrders()
    })
  )

  ipcMain.handle(
    IpcChannels.FETCH_ORDER_EMAILS,
    handleAsync(async (orderId: unknown) => {
      if (!orderId || typeof orderId !== 'string') {
        throw new Error('Valid order ID is required')
      }

      // Get the order to find emailIds and accountId
      const order = await databaseService.getOrderById(orderId)
      if (!order) {
        throw new Error('Order not found')
      }

      if (!order.emailIds || order.emailIds.length === 0) {
        return []
      }

      // Get the account credentials
      const accounts = await databaseService.getAccounts()
      const account = accounts.find(a => a.id === order.accountId)
      if (!account) {
        throw new Error('Account not found for this order')
      }

      // Fetch the emails
      return await fetchEmailsByUids(account, order.emailIds)
    })
  )

  console.log('IPC handlers registered successfully')
}

/**
 * Cleanup IPC handlers
 * Should be called before app quit
 */
export function unregisterIpcHandlers(): void {
  Object.values(IpcChannels).forEach(channel => {
    ipcMain.removeHandler(channel)
  })
  console.log('IPC handlers unregistered')
}
