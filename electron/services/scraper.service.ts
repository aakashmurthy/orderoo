/**
 * Scraper Service
 * Handles email scraping operations with proper error handling
 */

import type { ScrapeResult, ScrapeProgress, SerializableError } from '../types'
import { IpcChannels } from '../types'
import { databaseService } from './database.service'
import { scrapeAccount } from '../imap'
import { getMainWindow } from '../main'

/**
 * Send scrape progress to renderer
 */
function sendProgress(progress: ScrapeProgress): void {
  const mainWindow = getMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.SCRAPE_PROGRESS, progress)
  }
}

/**
 * Check if an error is an authentication error
 */
function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('authentication') ||
    message.includes('login') ||
    message.includes('log in') ||
    (error as Error & { textCode?: string }).textCode === 'AUTHENTICATIONFAILED'
  )
}

/**
 * Scrape all accounts for orders in parallel
 * Uses Promise.allSettled for error isolation - one account failure doesn't affect others
 */
export async function scrapeAllAccounts(
  dateFilter?: string
): Promise<ScrapeResult[]> {
  const accounts = await databaseService.getAccounts()
  console.log('Starting parallel scrape-all. Accounts:', accounts.length)

  const totalAccounts = accounts.length

  // Separate valid accounts from those with auth errors
  const validAccounts = accounts.filter(a => a.status !== 'auth_error')
  const skippedAccounts = accounts.filter(a => a.status === 'auth_error')

  // Log skipped accounts
  for (const account of skippedAccounts) {
    console.log(`Skipping account ${account.email} due to previous auth error`)
  }

  // Track progress for each account (for aggregated progress display)
  const progressMap = new Map<string, { current: number; total: number }>()

  // Initialize progress for all accounts
  for (const account of validAccounts) {
    progressMap.set(account.id, { current: 0, total: 0 })
  }

  /**
   * Send aggregated progress across all accounts
   */
  function sendAggregatedProgress() {
    let totalMessages = 0
    let processedMessages = 0
    let accountsCompleted = 0

    progressMap.forEach((progress) => {
      totalMessages += progress.total
      processedMessages += progress.current
      if (progress.total > 0 && progress.current >= progress.total) {
        accountsCompleted++
      }
    })

    // Add skipped accounts to completed count
    const completedAccounts = accountsCompleted + skippedAccounts.length

    sendProgress({
      currentAccount: completedAccounts,
      totalAccounts,
      accountEmail: `Processing ${validAccounts.length} accounts in parallel`,
      currentMessage: processedMessages,
      totalMessages
    })
  }

  // Send initial progress
  sendAggregatedProgress()

  // Process all valid accounts in parallel
  console.log(`Starting parallel scrape of ${validAccounts.length} accounts...`)

  const settledResults = await Promise.allSettled(
    validAccounts.map(async (account) => {
      console.log('Scraping account:', account.email)

      try {
        await scrapeAccount(account, dateFilter, (msgProgress) => {
          // Update this account's progress
          progressMap.set(account.id, msgProgress)
          // Send aggregated progress
          sendAggregatedProgress()
        })

        return {
          email: account.email,
          status: 'success' as const
        }
      } catch (error: unknown) {
        console.error('Error scraping account:', account.email, error)

        // Mark account as having auth error if applicable
        if (isAuthError(error)) {
          console.log(`Marking account ${account.email} as auth_error`)
          await databaseService.markAccountAuthError(account.id)
        }

        const serialized: SerializableError = error instanceof Error
          ? { message: error.message, stack: error.stack, name: error.name }
          : { message: 'Unknown error' }

        return {
          email: account.email,
          status: 'error' as const,
          error: serialized
        }
      }
    })
  )

  // Convert Promise.allSettled results to ScrapeResults
  const results: ScrapeResult[] = []

  // Add results from parallel processing
  for (const result of settledResults) {
    if (result.status === 'fulfilled') {
      results.push(result.value)
    } else {
      // This shouldn't happen since we catch errors inside the mapper,
      // but handle it just in case
      results.push({
        email: 'Unknown',
        status: 'error',
        error: { message: result.reason?.message || 'Unknown error' }
      })
    }
  }

  // Add skipped accounts
  for (const account of skippedAccounts) {
    results.push({
      email: account.email,
      status: 'skipped',
      reason: 'auth_error'
    })
  }

  console.log(`Parallel scrape completed. Results: ${results.length}`)
  return results
}
