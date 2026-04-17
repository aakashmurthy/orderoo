# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Agent Instructions

**IMPORTANT**: For this Electron app, always use `electron-pro` agent (via Task tool with `subagent_type="electron-pro"`) for:
- New features
- Refactoring
- Bug fixes
- New IPC methods/services
- Any changes to main process, renderer process, or preload scripts

`electron-pro` specializes in secure, performant Electron+TypeScript apps; understands IPC patterns, process isolation, security best practices.

## Commands

```bash
# Development (starts Vite + Electron concurrently)
npm run dev

# Production build (TypeScript compile + Vite build + electron-builder)
npm run build

# Release versioning
npm run release:patch   # 0.0.x
npm run release:minor   # 0.x.0
npm run release:major   # x.0.0
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Start development
npm run dev
```

## Architecture

**Stack:** Electron + React (Vite) + TypeScript + Tailwind CSS + lowdb

### Process Separation

- **Main Process** (`electron/`): Node.js, full system access
  - Services layer for business logic
  - IPC handlers for renderer communication
  - Database management

- **Renderer Process** (`src/`): Sandboxed React frontend
  - No direct Node.js/Electron access
  - Communicates via typed `window.electronAPI`

- **Preload** (`electron/preload.ts`): Secure IPC bridge
  - Uses `contextBridge` to expose limited API
  - Type-safe method definitions
  - No raw `ipcRenderer` exposure

### Security Architecture

```
┌─────────────────────────────────────────�
│         Renderer Process (React)        │
│  ┌─────────────────────────────────�   │
│  │   window.electronAPI (typed)    │   │
│  └──────────────┬──────────────────┘   │
└─────────────────┼──────────────────────┘
                  │ contextBridge
┌─────────────────┼──────────────────────�
│  Preload Script │                      │
│  ┌──────────────▼──────────────────�   │
│  │  Limited, validated IPC calls   │   │
│  └──────────────┬──────────────────┘   │
└─────────────────┼──────────────────────┘
                  │ IPC Channels
┌─────────────────▼──────────────────────�
│         Main Process (Node.js)         │
│  ┌─────────────────────────────────�   │
│  │      IPC Handler Registry       │   │
│  │   (validation + error handling) │   │
│  └──────────────┬──────────────────┘   │
│                 │                       │
│  ┌──────────────▼──────────────────�   │
│  │       Service Layer             │   │
│  │  • Database Service             │   │
│  │  • Scraper Service              │   │
│  └──────────────┬──────────────────┘   │
│                 │                       │
│  ┌──────────────▼──────────────────�   │
│  │   Data Layer (Encrypted DB)     │   │
│  └─────────────────────────────────┘   │
└────────────────────────────────────────┘
```

### Project Structure

```
electron/
├── main.ts                    # Application entry, window management
├── preload.ts                 # Secure API bridge (contextBridge)
├── imap.ts                    # Email fetching via IMAP
├── types/
│   └── index.ts              # Shared TypeScript definitions
├── services/
│   ├── database.service.ts   # Database abstraction layer
│   └── scraper.service.ts    # Email scraping orchestration
├── ipc/
│   └── handlers.ts           # IPC handler registration & validation
└── parsers/
    ├── walmart.ts            # Walmart email parsing strategies
    └── target.ts             # Target email parsing strategies

public/
└── logos/                    # Retailer logos for UI filter buttons
    ├── walmart.png
    ├── target.webp
    ├── costco.webp           # Future use
    └── sams.webp             # Future use

src/
├── App.tsx                   # Main React application
├── main.tsx                  # React entry point
└── types.ts                  # Re-exports shared types
```

### Data Flow

1. **User Action**: Frontend calls `window.electronAPI.scrapeAll(dateFilter)`
2. **IPC Bridge**: Preload forwards to IPC channel `orders:scrape-all`
3. **Validation**: IPC handler validates input
4. **Service Layer**: Calls `scraperService.scrapeAllAccounts()`
5. **Email Fetching**: `imap.ts` connects via IMAP
6. **Parsing**: `parsers/walmart.ts` extracts order data using cheerio
7. **Database**: `databaseService.upsertOrders()` persists to `storage.json`
8. **Response**: Returns results to renderer
9. **UI Update**: Frontend calls `electronAPI.getOrders()` to refresh

### Key Files

| File | Purpose |
|------|---------|
| `electron/main.ts` | App lifecycle, window creation, security config |
| `electron/preload.ts` | Secure API via contextBridge |
| `electron/types/index.ts` | Centralized types and IPC channel names |
| `electron/ipc/handlers.ts` | IPC handler registration with validation |
| `electron/services/database.service.ts` | Database ops (plain JSON) |
| `electron/services/scraper.service.ts` | Email scraping orchestration |
| `electron/imap.ts` | IMAP connection and email fetching (with timeouts) |
| `electron/parsers/walmart.ts` | Walmart email parsing with fallback strategies |
| `electron/parsers/target.ts` | Target email parsing with fallback strategies |
| `src/App.tsx` | React dashboard with stats and retailer filtering |
| `public/logos/` | Retailer logo images for filter buttons |
| `src/types.ts` | Renderer-side type exports |

### Database

- **Engine**: lowdb v7 with JSONFile adapter
- **Format**: Plain JSON — readable with any text editor
- **Location**:
  - Development: `storage.json` in project root
  - Production: `storage.json` in `app.getPath('userData')`
- **Access**: Via `databaseService` singleton only
- **Schema**: `{ orders: Order[], accounts: Account[] }`

### IPC API (via window.electronAPI)

All methods strongly typed and validated:

```typescript
// Account Management
electronAPI.getAccounts(): Promise<Account[]>
electronAPI.addAccount(account: Account): Promise<boolean>
electronAPI.updateAccount(account: Account): Promise<boolean>
electronAPI.deleteAccount(accountId: string): Promise<boolean>

// Order Operations
electronAPI.getOrders(): Promise<Order[]>
electronAPI.scrapeAll(dateFilter?: string): Promise<ScrapeResult[]>
```

### Security Features

1. **Context Isolation**: Enabled — renderer can't access Electron internals
2. **Node Integration**: Disabled — renderer can't use Node.js APIs
3. **Limited API**: Only specific methods exposed via preload
4. **Input Validation**: All IPC handlers validate parameters
5. **Type Safety**: Full TypeScript with strict mode
6. **Navigation Protection**: Blocks external URL navigation
7. **Window Security**: Prevents new window creation
8. **Local Storage**: Plain JSON in app directory
9. **XSS Protection**: Email HTML sanitized with DOMPurify before rendering
10. **IMAP Timeouts**: Connection (30s) and socket (60s) timeouts prevent hangs
11. **Connection Cleanup**: IMAP connections closed in `finally` blocks

See `SECURITY.md` for detailed security documentation.

## Development Guidelines

### Adding New IPC Methods

1. **Define channel** in `electron/types/index.ts`:
   ```typescript
   export const IpcChannels = {
     MY_METHOD: 'namespace:method-name',
   } as const
   ```

2. **Add to interface** in `electron/types/index.ts`:
   ```typescript
   export interface ElectronAPI {
     myMethod: (param: Type) => Promise<Result>
   }
   ```

3. **Register handler** in `electron/ipc/handlers.ts`:
   ```typescript
   ipcMain.handle(IpcChannels.MY_METHOD, handleAsync(async (param: any) => {
     validateParam(param)
     return await service.myMethod(param)
   }))
   ```

4. **Expose in preload** in `electron/preload.ts`:
   ```typescript
   const electronAPI: ElectronAPI = {
     myMethod: (param: Type) =>
       createInvoker<Result>(IpcChannels.MY_METHOD)(param),
   }
   ```

### Service Layer Pattern

All business logic lives in services:

```typescript
// electron/services/my.service.ts
export class MyService {
  async doSomething(): Promise<Result> {
    // Business logic here
  }
}

export const myService = new MyService()
```

### Error Handling

All IPC handlers use `handleAsync` wrapper — catches exceptions, logs errors, propagates to renderer for UI handling:

```typescript
ipcMain.handle(channel, handleAsync(async (...args) => {
  // Your code - errors automatically caught and logged
}))
```

## Parsing Notes

### Walmart Email Parser

- **Strategy Pattern**: Multiple fallback strategies for different email formats
  1. Alt text pattern (`quantity X item Y`)
  2. CSS class names (`.productName`)
  3. Product page links (`/ip/`)
  4. Generic table rows with images
  5. Fallback image detection

- **Order ID Normalization**: Non-numeric chars stripped to prevent duplicates
- **Cancellation Detection**: Checks subject/body for "cancel" keywords
- **Price Inference**: Frontend infers missing prices when possible
- **Deduplication**: Each product name processed once per email

### Target Email Parser

- **Strategy Pattern**: Similar to Walmart with Target-specific selectors
  1. CSS class names (`product-details`, `product-col-right`)
  2. Product page links (`/p/`, `/A-`)
  3. Generic table rows with images
  4. Target CDN image detection (`target.scene7.com`)

- **Order ID**: Extracted from `Order #123456789` pattern
- **Cancellation Detection**: Subject contains "cancel order #" or body has "Your order has been canceled"
- **Date Parsing**: From `banner-headline2` class with "Placed [Month] [Day], [Year]" format

## Adding New Retailers

To add support for a new retailer (e.g., Costco):

### 1. Create the Email Parser

Create `electron/parsers/[retailer].ts` following existing pattern:

```typescript
import { simpleParser } from 'mailparser'
import type { Order, OrderItem } from '../types'
import * as cheerio from 'cheerio'

export async function parse[Retailer]Email(
  emailContent: string,
  emailId: string,
  accountId: string
): Promise<Order | null> {
  // 1. Parse email and load HTML
  const parsed = await simpleParser(emailContent)
  const html = parsed.html || parsed.textAsHtml || ''
  const $ = cheerio.load(html)

  // 2. Extract order ID (return null if not found)
  // 3. Detect cancellation status
  // 4. Extract order date
  // 5. Extract total
  // 6. Extract items using multiple strategies
  // 7. Return Order object with retailer: '[Retailer]'
}
```

### 2. Update IMAP Search

In `electron/imap.ts`, add retailer to search list:

```typescript
const retailers = ['walmart', 'target', '[retailer]']  // Add new retailer
```

### 3. Add Parser Routing

In `electron/imap.ts`, add routing for new parser:

```typescript
import { parse[Retailer]Email } from './parsers/[retailer]'

// In the parsing section:
if (from.includes('[retailer]')) {
  order = await parse[Retailer]Email(part.body, emailId, account.id)
}
```

### 4. Add Logo

Place logo in `public/logos/[retailer].png` (or `.webp`)

### 5. Update Frontend

In `src/App.tsx`, add retailer to supported list:

```typescript
const SUPPORTED_RETAILERS = ['Walmart', 'Target', '[Retailer]'] as const

const RETAILER_LOGOS: Record<Retailer, string> = {
  Walmart: '/logos/walmart.png',
  Target: '/logos/target.webp',
  [Retailer]: '/logos/[retailer].png',  // Add new entry
}
```

### 6. Test with Sample Emails

1. Place sample `.eml` files in `email-examples/` for reference
2. Use gemini-cli to analyze large email files: `gemini "Analyze email-examples/[file].eml..." --yolo -o text`
3. Test both confirmation and cancellation email formats
4. Verify order ID, items, prices, quantities, and status extracted correctly

### Parser Best Practices

- **Multiple Strategies**: Implement fallbacks for different email formats
- **Normalize Order IDs**: Strip non-numeric chars to prevent duplicates
- **Handle Missing Data**: Use "Unknown Product" fallback when items can't be extracted
- **Cancellation Detection**: Check both subject and body
- **Deduplication**: Use `Set` to track processed product names
- **Debug Logging**: Use `[Retailer Parser]` prefix for console.log
- **Filter Marketing**: Skip items after "Order total" (usually recommendations)

## Build & Distribution

```bash
# Build for production
npm run build

# Output
release/
├── Orderoo Setup 0.0.3.exe   # Windows installer
└── win-unpacked/             # Unpacked files
```

## Documentation

- **SECURITY.md**: Security architecture and best practices
- **REFACTORING_NOTES.md**: Detailed refactoring changelog
- **CLAUDE.md**: This file — project overview and guidelines

## Troubleshooting

### TypeScript errors
- Ensure all imports use correct paths
- Check `electron/types/index.ts` for type definitions

### Build errors
- Run `npm install` to ensure dependencies
- Clear `dist` and `dist-electron` directories
- Check `tsconfig.json` includes correct paths

### Runtime errors
- Check console for IPC validation errors
- Verify service initialization in `electron/main.ts`
- Check database file permissions

## Testing Checklist

- [ ] `npm run build` succeeds without errors
- [ ] App starts in development mode
- [ ] Account CRUD operations function
- [ ] Email scraping completes successfully
- [ ] Orders display in dashboard
- [ ] Stats calculations accurate
- [ ] Dark mode toggle works
- [ ] No security warnings in DevTools console



## Documentation
Always use context7 when I need code generation, setup or configuration steps, or
library/API documentation. This means you should automatically use the Context7 MCP
tools to resolve library id and get library docs without me having to explicitly ask.