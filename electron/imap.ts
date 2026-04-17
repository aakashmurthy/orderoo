import imaps from 'imap-simple'
import { simpleParser } from 'mailparser'
import https from 'node:https'
import { app } from 'electron'
import type { Account, EmailContent, Order, PreParsedEmail, TestConnectionResult } from './types'
import { databaseService } from './services/database.service'
import { parseWalmartEmail } from './parsers/walmart'
import { parseTargetEmail } from './parsers/target'

/**
 * Check if insecure TLS is allowed (development only)
 * Security: This flag is ONLY honored in development builds
 */
function isInsecureTlsAllowed(): boolean {
  // Never allow in production builds - security critical
  if (app.isPackaged) {
    return false
  }
  // Only allow in development if explicitly set
  return process.env.ALLOW_INSECURE_TLS === 'true'
}

/**
 * Get CA certificates from the global agent (populated by win-ca on Windows)
 * Falls back to Node's default CA bundle if not available
 */
function getSystemCACertificates(): string[] | undefined {
  // Check if win-ca has injected certificates into the global agent
  const globalCa = https.globalAgent.options.ca
  if (globalCa) {
    if (Array.isArray(globalCa)) {
      return globalCa as string[]
    }
    return [globalCa as string]
  }
  // Return undefined to use Node's built-in CA bundle
  return undefined
}

export interface MessageProgress {
  current: number
  total: number
}

/**
 * Test IMAP connection for an account
 * Attempts to connect and open the INBOX to verify credentials
 */
export async function testConnection(account: Account): Promise<TestConnectionResult> {
  try {
    // Validate password exists
    if (!account.password) {
      return { success: false, error: 'No password configured' }
    }

    // Determine host
    const host = account.host || getHostForProvider(account.provider)
    if (!host) {
      return { success: false, error: 'No IMAP host configured. Please specify a host for custom providers.' }
    }

    // Check if insecure TLS is allowed (development only)
    const allowInsecureTls = isInsecureTlsAllowed()
    if (allowInsecureTls) {
      console.warn('[SECURITY] TLS certificate validation disabled - development mode only')
    }

    // Get system CA certificates (includes corporate proxy certs on Windows via win-ca)
    const systemCa = getSystemCACertificates()

    const config = {
      imap: {
        user: account.email,
        password: account.password,
        host,
        port: account.port || 993,
        tls: account.tls !== undefined ? account.tls : true,
        authTimeout: 10000,
        connTimeout: 15000,    // Shorter timeout for connection test (15s)
        socketTimeout: 15000,  // Shorter socket timeout for test (15s)
        tlsOptions: {
          servername: host,    // SNI - required for servers hosting multiple domains
          rejectUnauthorized: !allowInsecureTls,
          minVersion: 'TLSv1.2' as const, // Require TLS 1.2 minimum
          // Include system CA certificates (for corporate proxy support)
          ...(systemCa && { ca: systemCa })
        }
      }
    }

    let connection: imaps.ImapSimple | null = null

    try {
      console.log(`[Test Connection] Testing IMAP for ${account.email} via ${host}...`)
      connection = await imaps.connect(config)
      console.log(`[Test Connection] Connected. Opening INBOX...`)
      await connection.openBox('INBOX')
      console.log(`[Test Connection] Successfully connected to ${account.email}`)
      return { success: true }
    } catch (error) {
      console.error(`[Test Connection] Error for ${account.email}:`, error)

      // Extract a user-friendly error message
      let errorMessage = 'Connection failed'
      if (error instanceof Error) {
        const msg = error.message.toLowerCase()
        if (msg.includes('authenticationfailed') || msg.includes('invalid credentials') || msg.includes('authenticate failed')) {
          errorMessage = 'Invalid credentials. Please check your email and app password.'
        } else if (msg.includes('enotfound') || msg.includes('getaddrinfo')) {
          errorMessage = 'Server not found. Please check the IMAP host.'
        } else if (msg.includes('etimedout') || msg.includes('timeout') || msg.includes('timed out')) {
          errorMessage = 'Connection timed out. Please check your network and server settings.'
        } else if (msg.includes('econnrefused')) {
          errorMessage = 'Connection refused. Please check the IMAP port.'
        } else if (msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls')) {
          errorMessage = 'TLS/SSL error. The server certificate may be invalid.'
        } else if (msg.includes('econnreset')) {
          errorMessage = 'Connection reset by server. Please try again.'
        } else {
          errorMessage = error.message
        }
      }

      return { success: false, error: errorMessage }
    } finally {
      if (connection) {
        try {
          connection.end()
          console.log(`[Test Connection] Connection closed for ${account.email}`)
        } catch (closeError) {
          console.error(`[Test Connection] Error closing connection:`, closeError)
        }
      }
    }
  } catch (unexpectedError) {
    // Catch any unexpected errors to ensure we always return a result
    console.error(`[Test Connection] Unexpected error:`, unexpectedError)
    const message = unexpectedError instanceof Error ? unexpectedError.message : 'An unexpected error occurred'
    return { success: false, error: message }
  }
}

/**
 * Configuration for parallel processing
 * Batch size of 50 balances memory usage (~200-400MB) with parallelism
 * For systems with more RAM, this can be increased to 100
 */
const PARSE_BATCH_SIZE = 50

export async function scrapeAccount(
  account: Account,
  dateFilter?: string,
  onProgress?: (progress: MessageProgress) => void
): Promise<void> {
  // Validate password exists
  if (!account.password) {
    throw new Error(`Account ${account.email} has no password configured`)
  }

  // Check if insecure TLS is allowed (development only)
  const allowInsecureTls = isInsecureTlsAllowed()
  if (allowInsecureTls) {
    console.warn('[SECURITY] TLS certificate validation disabled - development mode only')
  }

  // Get system CA certificates (includes corporate proxy certs on Windows via win-ca)
  const systemCa = getSystemCACertificates()
  const host = account.host || getHostForProvider(account.provider)

  if (!host) {
    throw new Error(`Account ${account.email} has no IMAP host configured. Please specify a host for custom providers.`)
  }

  const config = {
    imap: {
      user: account.email,
      password: account.password,
      host,
      port: account.port || 993,
      tls: account.tls !== undefined ? account.tls : true,
      authTimeout: 10000,
      connTimeout: 30000,    // 30 second connection timeout
      socketTimeout: 60000,  // 60 second socket inactivity timeout
      tlsOptions: {
        servername: host,    // SNI - required for servers hosting multiple domains
        rejectUnauthorized: !allowInsecureTls,
        minVersion: 'TLSv1.2' as const, // Require TLS 1.2 minimum
        // Include system CA certificates (for corporate proxy support)
        ...(systemCa && { ca: systemCa })
      }
    }
  }

  let connection: imaps.ImapSimple | null = null
  try {
    console.log(`[${account.email}] Connecting to IMAP...`)
    connection = await imaps.connect(config)
    console.log(`[${account.email}] Connected. Opening INBOX...`)
    await connection.openBox('INBOX')

    // Search for order emails from supported retailers
    // Server-side filtering is more efficient than downloading all emails and filtering client-side
    const retailers = ['walmart', 'target']
    const fetchOptions = {
      bodies: [''],
      markSeen: false
    }

    console.log(`[${account.email}] Searching for order emails from: ${retailers.join(', ')}...`)

    type ImapMessage = Awaited<ReturnType<typeof connection.search>>[number]
    const allMessages: ImapMessage[] = []

    // Define subject patterns per retailer
    const retailerSubjectPatterns: Record<string, string[]> = {
      // Include cancellation keywords so those emails are fetched and parsed too.
      walmart: ['order', 'preorder', 'cancel', 'canceled', 'cancelled'],
      target: ['order', 'cancel', 'canceled', 'cancelled']
    }

    // Use specific server-side queries to minimize data transfer
    for (const retailer of retailers) {
      const subjectPatterns = retailerSubjectPatterns[retailer] || ['order']

      for (const subjectPattern of subjectPatterns) {
        const searchCriteria: any[] = [
          ['FROM', retailer],
          ['SUBJECT', subjectPattern]
        ]
        if (dateFilter) {
          searchCriteria.push(['SINCE', new Date(dateFilter)])
        }

        const retailerMessages = await connection.search(searchCriteria, fetchOptions)
        console.log(`[${account.email}] Found ${retailerMessages.length} messages from ${retailer} with subject '${subjectPattern}'`)
        allMessages.push(...retailerMessages)
      }
    }

    // Deduplicate by UID in case an email matches multiple criteria
    const seenUids = new Set<number>()
    const messages = allMessages.filter((msg: ImapMessage) => {
      const uid = msg.attributes.uid
      if (seenUids.has(uid)) return false
      seenUids.add(uid)
      return true
    })

    console.log(`[${account.email}] Total unique messages: ${messages.length}`)

    const ordersToUpsert = []
    const totalMessages = messages.length

    // Send initial progress (0 of total)
    if (onProgress) {
      onProgress({ current: 0, total: totalMessages })
    }

    console.log(`[${account.email}] Processing ${messages.length} messages in parallel batches of ${PARSE_BATCH_SIZE}...`)
    let processedCount = 0

    /**
     * Process a single message and return an Order or null
     * This function parses the email ONCE and passes pre-parsed data to retailer parsers
     */
    async function processMessage(message: typeof messages[number]): Promise<Order | null> {
      const part = message.parts.find((p: { which: string }) => p.which === '')
      if (!part) return null

      const emailId = message.attributes.uid.toString()

      try {
        // Parse email ONCE with simpleParser
        const parsed = await simpleParser(part.body)

        // Create pre-parsed email data to avoid double parsing in retailer parsers
        const preParsed: PreParsedEmail = {
          html: typeof parsed.html === 'string' ? parsed.html : '',
          textAsHtml: parsed.textAsHtml || '',
          subject: parsed.subject || '',
          date: parsed.date || new Date(),
          from: (parsed.from?.text || '').toLowerCase()
        }

        let order: Order | null = null

        // Route to appropriate parser based on sender
        if (preParsed.from.includes('target')) {
          const parsedOrder = await parseTargetEmail(preParsed)
          if (parsedOrder) {
            order = { ...parsedOrder, emailIds: [emailId], accountId: account.id }
          }
        } else if (preParsed.from.includes('walmart')) {
          const parsedOrder = await parseWalmartEmail(preParsed)
          if (parsedOrder) {
            order = { ...parsedOrder, emailIds: [emailId], accountId: account.id }
          }
        } else {
          // Fallback: detect retailer from subject
          const subject = preParsed.subject.toLowerCase()
          if (subject.includes('target') || preParsed.from.includes('target.com')) {
            const parsedOrder = await parseTargetEmail(preParsed)
            if (parsedOrder) {
              order = { ...parsedOrder, emailIds: [emailId], accountId: account.id }
            }
          } else {
            // Default to Walmart parser for backwards compatibility
            const parsedOrder = await parseWalmartEmail(preParsed)
            if (parsedOrder) {
              order = { ...parsedOrder, emailIds: [emailId], accountId: account.id }
            }
          }
        }

        if (order) {
          console.log(`[${account.email}] Found order: ${order.id} (${order.retailer}, ${order.status})`)
        }

        return order
      } catch (parseError) {
        console.error(`[${account.email}] Error parsing message UID: ${emailId}`, parseError)
        return null
      }
    }

    // Process messages in parallel batches for better performance
    for (let i = 0; i < messages.length; i += PARSE_BATCH_SIZE) {
      const chunk = messages.slice(i, i + PARSE_BATCH_SIZE)

      // Process chunk in parallel
      const chunkResults = await Promise.all(chunk.map(processMessage))

      // Collect valid orders
      for (const order of chunkResults) {
        if (order) {
          ordersToUpsert.push(order)
        }
      }

      // Update progress after processing each message in the chunk
      // This maintains per-message progress updates as requested
      for (let j = 0; j < chunk.length; j++) {
        processedCount++
        if (onProgress) {
          onProgress({ current: processedCount, total: totalMessages })
        }
      }
    }

    console.log(`[${account.email}] Processed ${processedCount} messages.`)

    if (ordersToUpsert.length > 0) {
      console.log(`[${account.email}] Saving ${ordersToUpsert.length} orders to database...`)
      await databaseService.upsertOrders(ordersToUpsert)
      console.log(`[${account.email}] Database saved.`)
    } else {
        console.log(`[${account.email}] No new orders to save.`)
    }

    console.log(`[${account.email}] Scraping complete.`)
  } catch (error) {
    console.error(`Error scraping account ${account.email}:`, error)
    throw error
  } finally {
    // Always close connection, even on error
    if (connection) {
      try {
        console.log(`[${account.email}] Closing connection...`)
        connection.end()
        console.log(`[${account.email}] Connection closed.`)
      } catch (closeError) {
        console.error(`[${account.email}] Error closing connection:`, closeError)
      }
    }
  }
}

function getHostForProvider(provider: string): string {
  switch (provider) {
    case 'gmail': return 'imap.gmail.com'
    case 'icloud': return 'imap.mail.me.com'
    default: return ''
  }
}

/**
 * Fetch email contents by UIDs for a given account
 */
export async function fetchEmailsByUids(account: Account, uids: string[]): Promise<EmailContent[]> {
  // Validate password exists
  if (!account.password) {
    throw new Error(`Account ${account.email} has no password configured`)
  }

  // Check if insecure TLS is allowed (development only)
  const allowInsecureTls = isInsecureTlsAllowed()
  if (allowInsecureTls) {
    console.warn('[SECURITY] TLS certificate validation disabled - development mode only')
  }

  // Get system CA certificates (includes corporate proxy certs on Windows via win-ca)
  const systemCa = getSystemCACertificates()
  const host = account.host || getHostForProvider(account.provider)

  const config = {
    imap: {
      user: account.email,
      password: account.password,
      host,
      port: account.port || 993,
      tls: account.tls !== undefined ? account.tls : true,
      authTimeout: 10000,
      connTimeout: 30000,    // 30 second connection timeout
      socketTimeout: 60000,  // 60 second socket inactivity timeout
      tlsOptions: {
        servername: host,    // SNI - required for servers hosting multiple domains
        rejectUnauthorized: !allowInsecureTls,
        minVersion: 'TLSv1.2' as const, // Require TLS 1.2 minimum
        // Include system CA certificates (for corporate proxy support)
        ...(systemCa && { ca: systemCa })
      }
    }
  }

  const emails: EmailContent[] = []
  let connection: imaps.ImapSimple | null = null

  try {
    console.log(`[${account.email}] Connecting to fetch emails...`)
    connection = await imaps.connect(config)
    await connection.openBox('INBOX')

    for (const uid of uids) {
      try {
        const searchCriteria = [['UID', uid]]
        const fetchOptions = {
          bodies: [''],
          markSeen: false
        }

        const messages = await connection.search(searchCriteria, fetchOptions)

        if (messages.length > 0) {
          const message = messages[0]
          const part = message.parts.find(p => p.which === '')

          if (part) {
            const parsed = await simpleParser(part.body)

            emails.push({
              uid,
              subject: parsed.subject || '',
              from: parsed.from?.text || '',
              date: parsed.date?.toISOString() || '',
              html: typeof parsed.html === 'string' ? parsed.html : '',
              text: parsed.text || ''
            })
          }
        }
      } catch (err) {
        console.error(`[${account.email}] Error fetching UID ${uid}:`, err)
      }
    }

    console.log(`[${account.email}] Fetched ${emails.length} emails`)
  } catch (error) {
    console.error(`Error connecting to account ${account.email}:`, error)
    throw error
  } finally {
    // Always close connection, even on error
    if (connection) {
      try {
        connection.end()
      } catch (closeError) {
        console.error(`[${account.email}] Error closing connection:`, closeError)
      }
    }
  }

  return emails
}
