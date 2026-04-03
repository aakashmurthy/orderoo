/**
 * Preload Script
 * Securely exposes a limited, typed API to the renderer process
 *
 * Security Best Practices:
 * 1. Uses contextBridge to safely expose APIs
 * 2. Only exposes specific, validated methods (not raw ipcRenderer)
 * 3. Provides type-safe interface for renderer
 * 4. No direct Node.js or Electron module access from renderer
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI, Account, ScrapeResult, ScrapeProgress, EmailContent, TestConnectionResult } from './types'
import { IpcChannels } from './types'

/**
 * Create a type-safe wrapper around ipcRenderer.invoke
 */
function createInvoker<T = unknown>(channel: string) {
  return (...args: unknown[]): Promise<T> => {
    return ipcRenderer.invoke(channel, ...args)
  }
}

/**
 * The API exposed to the renderer process
 * This is the ONLY way the renderer can communicate with the main process
 */
const electronAPI: ElectronAPI = {
  // Account operations
  getAccounts: createInvoker<Account[]>(IpcChannels.GET_ACCOUNTS),

  addAccount: (account: Account) =>
    createInvoker<boolean>(IpcChannels.ADD_ACCOUNT)(account),

  updateAccount: (account: Account) =>
    createInvoker<boolean>(IpcChannels.UPDATE_ACCOUNT)(account),

  deleteAccount: (accountId: string) =>
    createInvoker<boolean>(IpcChannels.DELETE_ACCOUNT)(accountId),

  testConnection: (account: Account) =>
    createInvoker<TestConnectionResult>(IpcChannels.TEST_CONNECTION)(account),

  // Order operations
  getOrders: createInvoker(IpcChannels.GET_ORDERS),

  scrapeAll: (dateFilter?: string) =>
    createInvoker<ScrapeResult[]>(IpcChannels.SCRAPE_ALL)(dateFilter),

  clearOrders: createInvoker<void>(IpcChannels.CLEAR_ORDERS),

  fetchOrderEmails: (orderId: string) =>
    createInvoker<EmailContent[]>(IpcChannels.FETCH_ORDER_EMAILS)(orderId),

  // Event listeners
  onScrapeProgress: (callback: (progress: ScrapeProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ScrapeProgress) => {
      callback(progress)
    }
    ipcRenderer.on(IpcChannels.SCRAPE_PROGRESS, handler)
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener(IpcChannels.SCRAPE_PROGRESS, handler)
    }
  },
}

/**
 * Expose the API to the renderer process via window.electronAPI
 * This makes the API available as: window.electronAPI.getAccounts(), etc.
 */
contextBridge.exposeInMainWorld('electronAPI', electronAPI)
