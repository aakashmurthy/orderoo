/**
 * Shared type definitions for the Electron application
 * Used across main, renderer, and preload processes
 */

export interface OrderItem {
  name: string
  quantity: number
  price: number
  image?: string
}

export interface Order {
  id: string
  date: string
  retailer: string
  items: OrderItem[]
  total: number
  status: 'placed' | 'cancelled'
  emailIds: string[]
  accountId: string
}

/**
 * Parsed order data without email/account metadata
 * Used by parsers for testability with raw email content
 */
export type ParsedOrder = Omit<Order, 'emailIds' | 'accountId'>

/**
 * Pre-parsed email data to avoid double parsing
 * simpleParser is called once in imap.ts, then this data is passed to parsers
 */
export interface PreParsedEmail {
  html: string
  textAsHtml: string
  subject: string
  date: Date
  from: string  // Already lowercased
}

export interface Account {
  id: string
  provider: 'icloud' | 'gmail' | 'custom'
  email: string
  password?: string
  host?: string
  port?: number
  tls?: boolean
  status?: 'ok' | 'auth_error'
}

export interface Data {
  orders: Order[]
  accounts: Account[]
}

/**
 * Result of testing an IMAP connection
 */
export interface TestConnectionResult {
  success: boolean
  error?: string
}

/**
 * IPC Channel names - centralized for type safety
 */
export const IpcChannels = {
  // Account operations
  GET_ACCOUNTS: 'accounts:get',
  ADD_ACCOUNT: 'accounts:add',
  UPDATE_ACCOUNT: 'accounts:update',
  DELETE_ACCOUNT: 'accounts:delete',
  TEST_CONNECTION: 'accounts:test-connection',

  // Order operations
  GET_ORDERS: 'orders:get',
  SCRAPE_ALL: 'orders:scrape-all',
  CLEAR_ORDERS: 'orders:clear',
  FETCH_ORDER_EMAILS: 'orders:fetch-emails',

  // Events (main -> renderer)
  SCRAPE_PROGRESS: 'orders:scrape-progress',
} as const

/**
 * Result types for IPC operations
 */
export interface IpcResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export interface SerializableError {
  message: string
  stack?: string
  name?: string
}

export interface ScrapeResult {
  email: string
  status: 'success' | 'error' | 'skipped'
  reason?: string
  error?: SerializableError
}

export interface ScrapeProgress {
  currentAccount: number
  totalAccounts: number
  accountEmail: string
  currentMessage: number
  totalMessages: number
}

export interface EmailContent {
  uid: string
  subject: string
  from: string
  date: string
  html: string
  text: string
}

/**
 * API exposed to renderer process via contextBridge
 */
export interface ElectronAPI {
  // Account operations
  getAccounts: () => Promise<Account[]>
  addAccount: (account: Account) => Promise<boolean>
  updateAccount: (account: Account) => Promise<boolean>
  deleteAccount: (accountId: string) => Promise<boolean>
  testConnection: (account: Account) => Promise<TestConnectionResult>

  // Order operations
  getOrders: () => Promise<Order[]>
  scrapeAll: (dateFilter?: string) => Promise<ScrapeResult[]>
  clearOrders: () => Promise<void>
  fetchOrderEmails: (orderId: string) => Promise<EmailContent[]>

  // Event listeners
  onScrapeProgress: (callback: (progress: ScrapeProgress) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
