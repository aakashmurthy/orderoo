---
name: scraper
description: Create a new retailer email parser for the orderoo Electron app given paths to sample order confirmation and order cancellation .eml files. Use when adding a new retailer, creating a new email parser, or when the user provides email examples from a retailer not yet supported (e.g. Costco, Sam's Club, Best Buy, Amazon).
---

# Scraper — Add New Retailer Email Parser

Given paths to one or more sample `.eml` files (order confirmation + order cancellation), generate a complete, working retailer email parser and wire it into the app.

## Quick start

User will say something like:
> "Add Costco parser, emails are in email-examples/costco-order.eml and email-examples/costco-cancel.eml"

You will:
1. Read and analyze each `.eml` file
2. Generate `electron/parsers/[retailer].ts`
3. Update `electron/imap.ts` (FROM routing + subject patterns)
4. Update `src/App.tsx` (SUPPORTED_RETAILERS, RETAILER_LOGOS)
5. Report what logo file is still needed

---

## Step-by-step instructions

### Step 1 — Read and analyze the email files

Read each provided `.eml` file in full. For each file, extract:

- **FROM address** — the full sender address (e.g. `auto-confirm@orders.costco.com`)
- **SUBJECT line** — used for status detection and routing
- **Order ID pattern** — how the order number appears in the HTML (label + surrounding markup)
- **Date pattern** — where the order date appears and how it's formatted
- **Order total pattern** — class names, surrounding text, or label used
- **Item structure** — CSS classes, link patterns, image sources, quantity/price layout
- **Cancellation signals** — subject keywords or body text that indicates a cancelled order

Use `simpleParser` mental model: the email HTML is available as a cheerio-loadable string after parsing. Inspect both the subject and the HTML body for patterns.

### Step 2 — Generate the parser file

Create `electron/parsers/[retailer-lowercase].ts` following this exact structure:

```typescript
import { simpleParser } from 'mailparser'
import type { ParsedOrder, PreParsedEmail } from '../types'
import * as cheerio from 'cheerio'

// ── constants ────────────────────────────────────────────────────────────────
const MIN_PRODUCT_IMAGE_SIZE = 50
const MAX_PRODUCT_IMAGE_SIZE = 2000
const VALID_ASPECT_RATIO_MIN = 0.5
const VALID_ASPECT_RATIO_MAX = 2.0

// ── helpers ──────────────────────────────────────────────────────────────────

function extractOrderId($: cheerio.CheerioAPI, subject: string): string | null {
  // Strategy 1: labeled element (e.g. "Order #", "Order Number:")
  // Strategy 2: subject line regex fallback
  // ALWAYS normalize: return id.replace(/\D/g, '')
}

function detectCancellation(subject: string, $: cheerio.CheerioAPI): boolean {
  // Check subject keywords first, then body text
}

function extractOrderDate($: cheerio.CheerioAPI, fallback: Date): string {
  // Return ISO string. Use fallback.toISOString() if not found.
}

function extractTotal($: cheerio.CheerioAPI): number {
  // Return 0 if not found. Parse "$1,234.56" → 1234.56
}

function extractItems($: cheerio.CheerioAPI): ParsedOrder['items'] {
  const items: ParsedOrder['items'] = []
  const seen = new Set<string>()

  // Strategy 0: most specific CSS class pattern from the emails
  // Strategy 1: product page link patterns (e.g. /p/, /product/)
  // Strategy 2: generic table rows with images + prices
  // Strategy 3: last-resort image heuristic

  return items
}

// ── entry point ──────────────────────────────────────────────────────────────

export async function parse[Retailer]Email(
  input: string | PreParsedEmail,
  emailId: string,
  accountId: string
): Promise<ParsedOrder | null> {
  let html: string
  let subject: string
  let date: Date

  if (typeof input === 'string') {
    const parsed = await simpleParser(input)
    html = parsed.html || parsed.textAsHtml || ''
    subject = parsed.subject || ''
    date = parsed.date || new Date()
  } else {
    html = input.html || input.textAsHtml
    subject = input.subject
    date = input.date
  }

  const $ = cheerio.load(html)

  const orderId = extractOrderId($, subject)
  if (!orderId) {
    console.log('[Retailer Parser] No order ID found, skipping')
    return null
  }

  const status = detectCancellation(subject, $) ? 'cancelled' : 'placed'
  const orderDate = extractOrderDate($, date)
  const total = extractTotal($)
  const items = extractItems($)

  if (items.length === 0) {
    console.log(`[[Retailer] Parser] No items found for order ${orderId}, using fallback`)
    items.push({ name: 'Unknown Product', quantity: 1, price: total, image: undefined })
  }

  return {
    id: orderId,
    date: orderDate,
    retailer: '[Retailer]',   // Must match SUPPORTED_RETAILERS entry exactly
    items,
    total,
    status,
  }
}
```

**Critical rules for the parser:**
- Accept `string | PreParsedEmail` (never parse twice if PreParsedEmail is passed)
- Normalize order ID: `id.replace(/\D/g, '')` — strips all non-numeric characters
- Return `null` if no order ID is found (not an order email)
- Always use a `seen = new Set<string>()` to deduplicate items by name
- Stop processing items once past "Order total" or equivalent cutoff marker
- Log with `[RetailerName Parser]` prefix for all console.log calls
- `status` must be `'placed' | 'cancelled'` (lowercase)
- `retailer` string must match exactly what you put in `SUPPORTED_RETAILERS` in App.tsx

### Step 3 — Update `electron/imap.ts`

**3a. Add import** at the top (keep sorted with existing imports):
```typescript
import { parse[Retailer]Email } from './parsers/[retailer]'
```

**3b. Add FROM-based search filter** in the `scrapeAccount()` function.

Find the section where `retailers` search criteria are defined. Add an entry:
```typescript
// The FROM address substring and subject patterns from the actual emails
{ from: '[retailer-domain-substring]', subjects: ['order'] }
```

**3c. Add routing logic** in the section that routes parsed emails to parsers.

The routing checks `preParsed.from.includes(...)`. Add BEFORE the fallback:
```typescript
} else if (preParsed.from.includes('[retailer-domain-substring]')) {
  order = await parse[Retailer]Email(preParsed, emailId, account.id)
}
```

Where `[retailer-domain-substring]` is the lowercase domain string from the FROM address in the sample emails (e.g. `costco.com`, `samsclub.com`).

### Step 4 — Update `src/App.tsx`

Find `SUPPORTED_RETAILERS` and add the new retailer:
```typescript
const SUPPORTED_RETAILERS = ['Walmart', 'Target', '[Retailer]'] as const
```

Find `RETAILER_LOGOS` and add the logo entry:
```typescript
const RETAILER_LOGOS: Record<Retailer, string> = {
  Walmart: './logos/walmart.png',
  Target: './logos/target.webp',
  [Retailer]: './logos/[retailer].png',   // adjust extension to match actual file
}
```

**Note:** If the logo file does not exist yet, inform the user:
> "You'll need to add a logo file at `public/logos/[retailer].[ext]`"

### Step 5 — Report what's done

After all file edits, output a summary:
```
Added [Retailer] parser:
- electron/parsers/[retailer].ts  — new parser
- electron/imap.ts                — routing + search filter added
- src/App.tsx                     — SUPPORTED_RETAILERS + RETAILER_LOGOS updated

Still needed:
- public/logos/[retailer].png     — add logo image manually
```

---

## Parsing patterns reference

### Order ID normalization (always do this)
```typescript
const raw = match[1]
const normalized = raw.replace(/\D/g, '')
return normalized || null
```

### Price parsing helper
```typescript
function parsePrice(str: string): number {
  const m = str.match(/\$(\d{1,3}(?:,\d{3})*\.\d{2})/)
  if (!m) return 0
  return parseFloat(m[1].replace(/,/g, ''))
}
```

### Quantity parsing
```typescript
// Try "Qty: 2", "Quantity: 2", "x2", or default to 1
const qtyMatch = cell.text().match(/(?:Qty|Quantity):?\s*(\d+)/i)
  || cell.text().match(/\bx(\d+)\b/i)
const quantity = qtyMatch ? parseInt(qtyMatch[1], 10) : 1
```

### Image heuristic (last resort)
```typescript
$('img').each((_, el) => {
  const w = parseInt($(el).attr('width') || '0')
  const h = parseInt($(el).attr('height') || '0')
  if (w < MIN_PRODUCT_IMAGE_SIZE || w > MAX_PRODUCT_IMAGE_SIZE) return
  if (h > 0) {
    const ratio = w / h
    if (ratio < VALID_ASPECT_RATIO_MIN || ratio > VALID_ASPECT_RATIO_MAX) return
  }
  const src = $(el).attr('src') || ''
  // … extract nearby name and price
})
```

### Cancellation detection pattern
```typescript
function detectCancellation(subject: string, $: cheerio.CheerioAPI): boolean {
  const subjectLower = subject.toLowerCase()
  if (subjectLower.includes('cancel')) return true
  const bodyText = $('body').text().toLowerCase()
  if (bodyText.includes('your order has been canceled')) return true
  if (bodyText.includes('your order has been cancelled')) return true
  return false
}
```

---

## Testing after creation

After generating the parser, use the `email-parser-tester` agent to validate it:
> "Test the [retailer] parser with email-examples/[file].eml"

Verify:
- [ ] Order ID is extracted and numeric
- [ ] Items array is non-empty
- [ ] Status is `'placed'` for confirmation, `'cancelled'` for cancellation
- [ ] Date and total are populated (or 0/today as graceful fallback)
- [ ] No TypeScript errors (`npm run build`)

---

## Common mistakes to avoid

- **Do not** hardcode an order ID — always extract from email content
- **Do not** return an empty items array without a fallback Unknown Product entry
- **Do not** forget to normalize the order ID (remove non-numeric chars)
- **Do not** add a retailer to `SUPPORTED_RETAILERS` without also updating `RETAILER_LOGOS`
- **Do not** forget the `PreParsedEmail` overload — imap.ts passes pre-parsed objects for performance
- **Do not** use `retailer: 'walmart'` (lowercase) — must match `SUPPORTED_RETAILERS` capitalization exactly
