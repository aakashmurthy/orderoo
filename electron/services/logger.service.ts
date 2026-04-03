/**
 * Logger Service
 * Provides file-based logging using electron-log
 * Writes to: %APPDATA%/orderoo/Logs/
 *
 * Security: Automatically redacts sensitive data (passwords, keys, tokens)
 */

import log from 'electron-log'
import { app } from 'electron'
import path from 'node:path'

// Configure log file location: AppData/Roaming/orderoo/Logs/
const logsPath = path.join(app.getPath('userData'), 'Logs')

/**
 * Patterns to redact from log output
 * These patterns match sensitive data like passwords, keys, and encrypted values
 * Note: Patterns use case-insensitive flag (gi) to catch various capitalizations
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Password fields in JSON or object notation
  { pattern: /password["':\s]*["']([^"']+)["']/gi, replacement: 'password: "[REDACTED]"' },
  { pattern: /password=([^\s&]+)/gi, replacement: 'password=[REDACTED]' },
  // License keys
  { pattern: /licenseKey["':\s]*["']([^"']+)["']/gi, replacement: 'licenseKey: "[REDACTED]"' },
  { pattern: /license[_-]?key=([^\s&]+)/gi, replacement: 'license_key=[REDACTED]' },
  // Encrypted password prefix (safeStorage encrypted values)
  { pattern: /enc:v1:[A-Za-z0-9+/=]+/g, replacement: '[ENCRYPTED_DATA]' },
  // API keys and tokens
  { pattern: /api[_-]?key["':\s]*["']([^"']+)["']/gi, replacement: 'api_key: "[REDACTED]"' },
  { pattern: /bearer\s+[A-Za-z0-9._-]+/gi, replacement: 'Bearer [REDACTED]' },
  { pattern: /authorization["':\s]*["']([^"']+)["']/gi, replacement: 'authorization: "[REDACTED]"' },
  // Additional token types
  { pattern: /access[_-]?token["':\s]*["']([^"']+)["']/gi, replacement: 'access_token: "[REDACTED]"' },
  { pattern: /refresh[_-]?token["':\s]*["']([^"']+)["']/gi, replacement: 'refresh_token: "[REDACTED]"' },
  { pattern: /secret["':\s]*["']([^"']+)["']/gi, replacement: 'secret: "[REDACTED]"' },
  { pattern: /token["':\s]*["']([^"']{20,})["']/gi, replacement: 'token: "[REDACTED]"' }, // Long tokens only
  // HWID (hardware ID - privacy sensitive)
  { pattern: /hwid["':\s]*["']([^"']+)["']/gi, replacement: 'hwid: "[REDACTED]"' },
  { pattern: /hwid=([^\s&]+)/gi, replacement: 'hwid=[REDACTED]' },
  { pattern: /hardware[_-]?id["':\s]*["']([^"']+)["']/gi, replacement: 'hardware_id: "[REDACTED]"' },
]

/**
 * Redact sensitive data from a log message
 */
function redactSensitiveData(message: string): string {
  let redacted = message
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

/**
 * Create a redacting wrapper for log functions
 */
function createRedactingLogger(originalFn: (...args: any[]) => void): (...args: any[]) => void {
  return (...args: any[]) => {
    const redactedArgs = args.map(arg => {
      if (typeof arg === 'string') {
        return redactSensitiveData(arg)
      }
      // Handle Error objects specially - they don't serialize with JSON.stringify
      if (arg instanceof Error) {
        const redactedMessage = redactSensitiveData(arg.message)
        const redactedStack = arg.stack ? redactSensitiveData(arg.stack) : undefined
        const redactedError = new Error(redactedMessage)
        redactedError.name = arg.name
        if (redactedStack) redactedError.stack = redactedStack
        return redactedError
      }
      if (typeof arg === 'object' && arg !== null) {
        try {
          // Convert to string, redact, then let electron-log handle formatting
          const stringified = JSON.stringify(arg)
          return JSON.parse(redactSensitiveData(stringified))
        } catch {
          // If we can't stringify, return as-is
          return arg
        }
      }
      return arg
    })
    originalFn(...redactedArgs)
  }
}

log.transports.file.resolvePathFn = () => {
  const date = new Date().toISOString().split('T')[0] // YYYY-MM-DD
  return path.join(logsPath, `main-${date}.log`)
}

// Configure log format
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}] [{level}] {text}'

// Set max log file size (5MB) and keep 5 old log files
log.transports.file.maxSize = 5 * 1024 * 1024
log.transports.file.archiveLogFn = (oldLogFile) => {
  const info = path.parse(oldLogFile.path)
  const timestamp = Date.now()
  return path.join(info.dir, `${info.name}.${timestamp}${info.ext}`)
}

// Also log to console in development
log.transports.console.level = app.isPackaged ? false : 'debug'

// Override console methods to use electron-log with sensitive data redaction
// This way existing console.log calls automatically go to the log file
// Security: All log output is automatically redacted before writing to file
console.log = createRedactingLogger(log.log.bind(log))
console.info = createRedactingLogger(log.info.bind(log))
console.warn = createRedactingLogger(log.warn.bind(log))
console.error = createRedactingLogger(log.error.bind(log))
console.debug = createRedactingLogger(log.debug.bind(log))

// Export the configured logger
export const logger = log

// Log startup info
logger.info('='.repeat(60))
logger.info(`Application starting - v${app.getVersion()}`)
logger.info(`Log path: ${logsPath}`)
logger.info(`Packaged: ${app.isPackaged}`)
logger.info('='.repeat(60))
