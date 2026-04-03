/**
 * Renderer Process Type Definitions
 * Re-exports shared types for use in the React application
 *
 * Note: The global Window interface declaration is in electron/types/index.ts
 * to avoid duplication across processes.
 */

export type {
  OrderItem,
  Order,
  Account,
  ElectronAPI,
  ScrapeResult,
  ScrapeProgress,
  EmailContent,
  TestConnectionResult
} from '../electron/types'
