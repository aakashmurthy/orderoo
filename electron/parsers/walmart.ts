import { simpleParser } from 'mailparser'
import type { ParsedOrder, OrderItem, PreParsedEmail } from '../types'
import * as cheerio from 'cheerio'

/**
 * Image detection constants for product identification
 */
const MIN_PRODUCT_IMAGE_SIZE = 50 // Minimum width/height in pixels to be considered a product image
const MIN_ASPECT_RATIO = 0.5 // Minimum width/height ratio (excludes tall banners)
const MAX_ASPECT_RATIO = 2.0 // Maximum width/height ratio (excludes wide banners)
const MIN_DOM_DEPTH_FOR_HEURISTIC = 10 // Minimum parent depth to infer product image in "last resort" strategy
const PLACEHOLDER_IMAGE = '/unknown-product.webp' // Fallback image for products without images

/**
 * Parse a Walmart order confirmation email
 * @param input - Either raw email content (string) or pre-parsed email data (PreParsedEmail)
 *                Using PreParsedEmail avoids double parsing when simpleParser was already called
 */
export async function parseWalmartEmail(input: string | PreParsedEmail): Promise<ParsedOrder | null> {
  let html: string
  let subject: string
  let date: Date

  if (typeof input === 'string') {
    // Legacy path - parse the email (for backward compatibility)
    const parsed = await simpleParser(input)
    html = parsed.html || parsed.textAsHtml || ''
    subject = parsed.subject || ''
    date = parsed.date || new Date()
  } else {
    // Optimized path - use pre-parsed data (avoids double simpleParser call)
    html = input.html || input.textAsHtml || ''
    subject = input.subject
    date = input.date
  }

  const $ = cheerio.load(html)

  // 1. Extract Order ID
  let orderId = ''
  // Look for "Order number" text in common containers
  $('div, td, span, p').each((_i, el) => {
    const text = $(el).text().trim()
    // Matches "Order number: 2000139-29652998" or "Order number: #2000142-61509130"
    if (/Order number/i.test(text)) {
      const match = text.match(/Order number:?\s*#?([0-9-]+)/i)
      if (match) {
        orderId = match[1]
        return false // break
      }
      // Sometimes the number is in a child anchor (may include # prefix)
      const anchorText = $(el).find('a').text().trim()
      if (anchorText) {
        const anchorMatch = anchorText.match(/^#?([0-9-]+)$/)
        if (anchorMatch) {
          orderId = anchorMatch[1]
          return false
        }
      }
    }
  })

  if (!orderId) {
      // Try regex on full text
      const text = $.text()
      const match = text.match(/Order #\s*([0-9-]+)/i)
      if (match) orderId = match[1]
  }

  // Try to extract from subject if not found in body
  if (!orderId && subject) {
      const subjectMatch = subject.match(/order\s+#?\s*([0-9-]+)/i)
      if (subjectMatch) {
          orderId = subjectMatch[1]
      }
  }

  if (!orderId) {
      // If we can't find an order ID, it's likely not a valid order email
      return null
  }

  // Normalize Order ID to prevent duplicates (remove hyphens and spaces)
  // This ensures 2000139-89114728 and 200013989114728 are treated as the same order
  // Note: This intentionally strips all non-numeric characters. In rare cases, two distinct
  // order IDs that differ only by separator characters could collide (e.g., "100-200" and "100200").
  // This is an acceptable tradeoff since Walmart order IDs follow a consistent numeric format.
  orderId = orderId.replace(/[^0-9]/g, '')

  let status: 'placed' | 'cancelled' = 'placed'
  // Basic detection of cancellation
  if (subject && subject.toLowerCase().includes('canceled')) {
    status = 'cancelled'
  }

  // Check if it's a placed order
  // User said: title of the form "thanks for your order"
  if (!subject.toLowerCase().includes('thanks for your order') && !subject.toLowerCase().includes('check your receipt')) {
      // Might be a shipping update or something else.
      // For now, we can be strict or lenient.
      // If we are strict, we might miss some.
      // Let's rely on finding an Order ID and Total.
  }

  // 2. Extract Total
  let total = 0
  // Strategy: Find "Order total" and look for the price in the whole document text relative to it,
  // or use specific structure if possible.
  // Given the HTML structure varies, we'll try to find the "Order total" header/text
  // and then find the first price pattern following it.
  
  const fullHtml = $.html()
  const orderTotalIndex = fullHtml.indexOf('Order total')
  
  if (orderTotalIndex !== -1) {
    // Look for price after "Order total"
    const textAfterTotal = fullHtml.substring(orderTotalIndex)
    const priceMatch = textAfterTotal.match(/\$(\d{1,3}(?:,\d{3})*\.\d{2})/)
    if (priceMatch) {
      total = parseFloat(priceMatch[1].replace(/,/g, ''))
    }
  } else {
    // Fallback: look for Total in text
    const text = $.text()
    const totalMatch = text.match(/Total\s*\$(\d+\.\d{2})/i)
    if (totalMatch) {
      total = parseFloat(totalMatch[1])
    }
  }

  // 3. Extract Items
  const items: OrderItem[] = []
  
  // Strategy 0: Alt text pattern "quantity X item Y" (Gmail/Google proxy format)
  // Example: <img alt="quantity 5 item Pokemon..." ...>
  let itemElements = $('img').filter((_, el) => {
      const alt = $(el).attr('alt') || ''
      return /^quantity \d+ item /i.test(alt)
  })
  let strategy = 'alt-pattern'

  if (itemElements.length === 0) {
    // Strategy 1: Class name (common in Walmart emails)
    itemElements = $('[class*="productName"]')
    strategy = 'class'
  }

  if (itemElements.length === 0) {
    // Strategy 2: Links to product pages
    itemElements = $('a[href*="/ip/"]')
    strategy = 'link'
  }

  if (itemElements.length === 0) {
    // Strategy 3: Generic Table Rows with Image and Price
    // Look for TRs that contain an IMG and a Price pattern
    let rows = $('tr')
    // If no TRs, try DIVs that might be rows
    if (rows.length === 0) {
         rows = $('div[class*="row"], div[class*="item"]')
    }

    itemElements = rows.filter((_i, el) => {
        const hasImg = $(el).find('img').length > 0
        const text = $(el).text()
        // Relaxed price regex: allows $10 or $10.00
        const hasPrice = /\$\d+(?:,\d{3})*(?:\.\d{2})?/.test(text)
        // Avoid rows that look like totals/headers or payment info
        const isTotal = /Total|Subtotal|Tax|Shipping|Order placed|Order number|Temporary hold released|Items canceled|Payment|Visa|Mastercard|Amex|ending in/i.test(text)
        return hasImg && hasPrice && !isTotal
    })
    if (itemElements.length > 0) strategy = 'generic-row'
  }

  if (itemElements.length === 0) {
      // Strategy 4: Last Resort - Find any image that looks like a product
      // Look for images with 'prod' or 'image' in src, or valid alt text
      // And ensure they are not social icons, logos, etc.
      const images = $('img')
      itemElements = images.filter((_i, el) => {
          const src = $(el).attr('src') || ''
          const alt = $(el).attr('alt') || ''
          const width = parseInt($(el).attr('width') || '0')
          const height = parseInt($(el).attr('height') || '0')

          // Filter out tiny icons
          if (width > 0 && width < MIN_PRODUCT_IMAGE_SIZE) return false
          if (height > 0 && height < MIN_PRODUCT_IMAGE_SIZE) return false

          // Filter out common non-product images
          if (/logo|social|facebook|twitter|instagram|pinterest|youtube|spacer|pixel|tracker|analytics|home page|google play|app store/i.test(src)) return false
          if (/logo|social|facebook|twitter|instagram|pinterest|youtube|home page|google play|app store/i.test(alt)) return false

          // Strong signals it IS a product
          if (src.includes('odnHeight') || src.includes('odnWidth')) return true
          
          const parentLink = $(el).closest('a')
          if (parentLink.length > 0 && parentLink.attr('href')?.includes('/ip/')) return true

          // Specific check for Walmart logo/branding if not caught above
          // If it says 'walmart' but isn't from walmartimages and has no product signals, likely a logo
          if (src.toLowerCase().includes('walmart')) {
             return false
          }

          // If no specific markers, rely on size but exclude very wide banners
          // Only if we have dimensions
          if (width > 0 && height > 0) {
              if (width < MIN_PRODUCT_IMAGE_SIZE || height < MIN_PRODUCT_IMAGE_SIZE) return false // Too small
              const ratio = width / height
              if (ratio > MIN_ASPECT_RATIO && ratio < MAX_ASPECT_RATIO) return true // Square-ish
              return false // Likely banner or spacer
          }

          // If no dimensions and no other signals, it's risky.
          // But if we are in "Last Resort", maybe we take the risk if it's not a known bad pattern?
          // Let's skip it to be safe, unless it's a very deep image (like the user's xpath)
          // The user's xpath was very deep.
          if ($(el).parents().length > MIN_DOM_DEPTH_FOR_HEURISTIC) return true

          return false
      })
      if (itemElements.length > 0) strategy = 'images-only'
  }

  console.log(`[Walmart Parser] Found ${itemElements.length} potential items using strategy: ${strategy}`)
  
  const processedNames = new Set<string>()

  itemElements.each((_, el) => {
    let name = ''
    let container: ReturnType<typeof $> = $(el) // Default to the element itself (might be img)
    let quantity = 1
    let image = ''
    let price = 0

    if (strategy === 'alt-pattern') {
         const alt = $(el).attr('alt') || ''
         // Parse "quantity 5 item Name"
         const match = alt.match(/^quantity\s+(\d+)\s+item\s+(.+)$/i)
         if (match) {
             quantity = parseInt(match[1], 10)
             name = match[2].trim()
         }
         image = $(el).attr('src') || ''
         // Container for price lookup
         container = $(el).closest('tr')
         if (container.length === 0) container = $(el).closest('div')
    } else if (strategy === 'generic-row') {
        // ... existing generic row logic ...
        container = $(el)
        const anchor = container.find('a').first()
        if (anchor.length) name = anchor.text().trim()
        
        if (!name) {
            name = container.find('span, div, p').first().text().trim()
        }
        if (!name) name = container.text().trim().split('\n')[0]
    } else if (strategy === 'images-only') {
        // If we just found an image, look around for the name
        // 1. Alt text
        name = $(el).attr('alt') || ''
        // 2. Title of parent link
        if (!name) name = $(el).closest('a').attr('title') || ''
        // 3. Text in parent container
        if (!name) {
             // Go up to a container and look for text
             // Try immediate parent first
             let parent = $(el).parent()
             name = parent.text().trim().split('\n')[0]
             
             // If that's empty or just price/qty, go up one more
             if (!name || /^\$|Qty/.test(name)) {
                 parent = parent.parent()
                 // Get text but exclude the current image's text if any? No, image has no text.
                 // We want to find the product name. It's usually the longest string in the block.
                 const text = parent.text().trim()
                 // Split by newlines and find the longest line that isn't a long description?
                 // Or just take the first non-empty line that isn't price/qty
                 const lines = text.split('\n').map(l => l.trim()).filter(l => l)
                 for (const line of lines) {
                     if (!/^\$|Qty|Arrives|Sold by|Return|Track|Temporary hold/i.test(line) && line.length > 3) {
                         name = line
                         break
                     }
                 }
             }
        }
        // Set container to parent for price/qty extraction
        container = $(el).closest('tr')
        if (container.length === 0) container = $(el).closest('div[class*="row"], div[class*="item"]')
        if (container.length === 0) container = $(el).parent().parent()
    } else {
        // Class or Link strategy
        name = $(el).text().trim()
        if (!name && strategy === 'link') {
            name = $(el).attr('title') || $(el).find('img').attr('alt') || ''
        }
        container = $(el).closest('tr')
        if (container.length === 0) container = $(el).closest('div')
    }

    if (!name) return
    
    // Clean up name
    name = name.replace(/\s+/g, ' ').trim()
    // Remove specific prefixes requested by user
    name = name.replace(/^Pokemon Trading Card Games? /i, '')
    name = name.replace(/^Collectible Pokemon Trading Card Game /i, '')
    name = name.replace(/^Pokemon TCG Scarlet (& )?Violet /i, '')

    if (name.length > 100) name = name.substring(0, 100) + '...' // Truncate if too long

    // Deduplicate
    if (processedNames.has(name)) return
    processedNames.add(name)

    // Filter out "You might also like" items
    if (orderTotalIndex !== -1) {
      const itemHtml = $.html(el)
      const itemIndex = fullHtml.indexOf(itemHtml)
      // Only filter if we successfully found the item in the HTML string
      if (itemIndex !== -1 && itemIndex > orderTotalIndex) {
        return 
      }
    }

    // Try to find price and quantity
    // If strategy is alt-pattern, we already have quantity and image
    // But we might still want to find price
    
    // Attempt to find the container row (tr) or parent container
    // Note: 'container' is already defined above based on strategy, but we can refine it here if needed
    if (container.length === 0) {
        container = $(el).closest('tr')
        if (container.length === 0) {
            // Fallback for div-based layouts: go up to a container that might hold the row info
            container = $(el).closest('div[class*="row"], div[class*="item"], table') 
            if (container.length === 0) {
                container = $(el).parent().parent()
            }
        }
    }
    
    if (container.length > 0) {
        // 1. Extract Image
        if (!image) {
            const img = container.find('img').first()
            if (img.length) {
                image = img.attr('src') || ''
            }
        }

        // 2. Extract Quantity
        if (strategy !== 'alt-pattern') {
            const containerText = container.text()
            const qtyMatch = containerText.match(/Qty:?\s*(\d+)/i) || containerText.match(/Quantity:?\s*(\d+)/i)
            if (qtyMatch) {
                quantity = parseInt(qtyMatch[1], 10)
            }
        }

        // 3. Extract Price
        // Look for price pattern. 
        // Note: This might pick up unit price or total price for the line.
        let priceContainer = container
        let priceFound = false
        let attempts = 0
        
        // Search up the tree for a price if not found in immediate container
        // But stop if we hit the body or a very large container
        while (!priceFound && attempts < 5 && priceContainer.length > 0 && (priceContainer[0] as { tagName?: string }).tagName !== 'body') {
             const text = priceContainer.text()
             // Look for price, but avoid "Order total" if we went up too far
             // Simple check: if text contains "Order total", we might have gone too far, 
             // UNLESS the item is in the same table as the total (rare but possible)
             
             const priceMatch = text.match(/\$(\d{1,3}(?:,\d{3})*\.\d{2})/)
             if (priceMatch) {
                 price = parseFloat(priceMatch[1].replace(/,/g, ''))
                 priceFound = true
             } else {
                 priceContainer = priceContainer.parent()
                 attempts++
             }
        }
    }
    
    items.push({
      name: name,
      price,
      quantity,
      image: image || PLACEHOLDER_IMAGE
    })
  })

  // Post-processing: Fallback for price if 0
  // If we have only 1 item type and we know the total, assign the total to the item price
  if (items.length === 1 && items[0].price === 0 && total > 0) {
      items[0].price = total
  } else if (items.length > 0 && total > 0) {
      // If multiple items and some have 0 price, we can't easily guess.
      // But if ALL have 0 price, maybe we can split the total? No, that's inaccurate.
      // Let's leave it as 0 for now if we can't find it.
  }

  // Strategy 5: Unknown Product fallback
  // When no items found but order is valid, create placeholder entry
  // This handles "summary view" emails that show "X items" without listing products
  if (items.length === 0 && orderId) {
    let itemCount = 1

    // Look for "X items" pattern in the email
    const fullText = $.text()
    const itemCountMatch = fullText.match(/(\d+)\s+items?\b/i)
    if (itemCountMatch) {
      itemCount = parseInt(itemCountMatch[1], 10)
    }

    items.push({
      name: 'Unknown Product',
      price: total > 0 ? total / itemCount : 0,
      quantity: itemCount,
      image: PLACEHOLDER_IMAGE
    })

    console.log(`[Walmart Parser] No items found, using Unknown Product fallback with quantity: ${itemCount}`)
  }

  return {
    id: orderId,
    date: date.toISOString(),
    retailer: 'Walmart',
    items,
    total,
    status
  }
}
