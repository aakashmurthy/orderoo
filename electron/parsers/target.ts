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
 * Parse a Target order confirmation email
 * @param input - Either raw email content (string) or pre-parsed email data (PreParsedEmail)
 *                Using PreParsedEmail avoids double parsing when simpleParser was already called
 */
export async function parseTargetEmail(input: string | PreParsedEmail): Promise<ParsedOrder | null> {
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
  // Target format: "Order #123456789" or "order #:912002420547381"
  let orderId = ''

  // Look for "Order #" pattern in header-ordernum class
  $('[class*="header-ordernum"], .header-ordernum').each((_i, el) => {
    const text = $(el).text().trim()
    const match = text.match(/Order\s*#:?\s*(\d+)/i)
    if (match) {
      orderId = match[1]
      return false // break
    }
    // Check for anchor inside
    const anchorText = $(el).find('a').text().trim()
    if (anchorText && /^\d+$/.test(anchorText)) {
      orderId = anchorText
      return false
    }
  })

  // Try finding in any element
  if (!orderId) {
    $('div, td, span, p, a').each((_i, el) => {
      const text = $(el).text().trim()
      const match = text.match(/Order\s*#:?\s*(\d+)/i)
      if (match) {
        orderId = match[1]
        return false // break
      }
    })
  }

  // Try regex on full text
  if (!orderId) {
    const text = $.text()
    const match = text.match(/Order\s*#:?\s*(\d+)/i)
    if (match) orderId = match[1]
  }

  // Try to extract from subject if not found in body
  // Subject format: "order #912002420547381" or "order #:912002420547381"
  if (!orderId && subject) {
    const subjectMatch = subject.match(/order\s*#:?\s*(\d+)/i)
    if (subjectMatch) {
      orderId = subjectMatch[1]
    }
  }

  if (!orderId) {
    // If we can't find an order ID, it's likely not a valid order email
    console.log('[Target Parser] No order ID found, skipping email')
    return null
  }

  // Normalize Order ID to prevent duplicates (remove non-numeric characters)
  // Note: This intentionally strips all non-numeric characters. In rare cases, two distinct
  // order IDs that differ only by separator characters could collide. This is an acceptable
  // tradeoff since Target order IDs follow a consistent numeric format.
  orderId = orderId.replace(/[^0-9]/g, '')
  console.log(`[Target Parser] Found order ID: ${orderId}`)

  // 2. Determine order status
  let status: 'placed' | 'cancelled' = 'placed'

  // Check subject for cancellation keywords
  if (subject) {
    const lowerSubject = subject.toLowerCase()
    if (lowerSubject.includes('cancel') || lowerSubject.includes('had to cancel')) {
      status = 'cancelled'
    }
  }

  // Check body for cancellation indicators
  // Target uses: <h1 ...>Your order has been canceled</h1> or "Your order has\nbeen canceled"
  const fullText = $.text().toLowerCase()
  if (fullText.includes('your order has') && fullText.includes('been canceled')) {
    status = 'cancelled'
  }

  // Also check for H1 with cancellation message
  $('h1').each((_i, el) => {
    const h1Text = $(el).text().toLowerCase()
    if (h1Text.includes('canceled') || h1Text.includes('cancelled')) {
      status = 'cancelled'
      return false
    }
  })

  console.log(`[Target Parser] Order status: ${status}`)

  // 3. Extract Order Date
  // Look for banner-headline2 class with "Placed [Month] [Day], [Year]"
  let orderDate = date
  $('.banner-headline2, [class*="banner-headline2"]').each((_i, el) => {
    const text = $(el).text().trim()
    const dateMatch = text.match(/Placed\s+(\w+\s+\d{1,2},?\s+\d{4})/i)
    if (dateMatch) {
      const parsedDate = new Date(dateMatch[1])
      if (!isNaN(parsedDate.getTime())) {
        orderDate = parsedDate
      }
      return false
    }
  })

  // 4. Extract Total
  let total = 0

  // Strategy 1: Look for order-total-price class
  $('.order-total-price, [class*="order-total-price"]').each((_i, el) => {
    const text = $(el).text().trim()
    const priceMatch = text.match(/\$(\d{1,3}(?:,\d{3})*\.\d{2})/)
    if (priceMatch) {
      total = parseFloat(priceMatch[1].replace(/,/g, ''))
      return false
    }
  })

  // Strategy 2: Look for "Order total" text and find price after it
  if (total === 0) {
    const fullHtml = $.html()
    const orderTotalIndex = fullHtml.toLowerCase().indexOf('order total')

    if (orderTotalIndex !== -1) {
      const textAfterTotal = fullHtml.substring(orderTotalIndex)
      const priceMatch = textAfterTotal.match(/\$(\d{1,3}(?:,\d{3})*\.\d{2})/)
      if (priceMatch) {
        total = parseFloat(priceMatch[1].replace(/,/g, ''))
      }
    }
  }

  // Strategy 3: Fallback - look for Total in text
  if (total === 0) {
    const text = $.text()
    const totalMatch = text.match(/Total\s*\$(\d+\.\d{2})/i)
    if (totalMatch) {
      total = parseFloat(totalMatch[1])
    }
  }

  console.log(`[Target Parser] Order total: $${total}`)

  // 5. Extract Items
  const items: OrderItem[] = []
  const fullHtml = $.html()

  // Use "Order Summary" section as the cutoff marker (not "Order total" which can appear as a summary at the top)
  // This handles Target emails with "Summary → Details → Summary" structure
  let orderTotalIndex = fullHtml.toLowerCase().indexOf('order summary')

  // Fallback: look for recommendation sections
  if (orderTotalIndex === -1) {
    orderTotalIndex = fullHtml.toLowerCase().indexOf('you might also like')
  }
  if (orderTotalIndex === -1) {
    orderTotalIndex = fullHtml.toLowerCase().indexOf('recommended for you')
  }

  // Strategy 0: CSS class names (product-details, product-col-right)
  // This is the primary strategy for Target emails
  let itemElements = $('td.product-details, td.product-col-right, td[class*="product-details"], td[class*="product-col-right"]')
  let strategy = 'class'

  if (itemElements.length === 0) {
    // Strategy 1: Links to Target product pages (contain /p/ or /A- patterns)
    itemElements = $('a[href*="/p/"], a[href*="/A-"]')
    strategy = 'link'
  }

  if (itemElements.length === 0) {
    // Strategy 2: Generic Table Rows with Image and Price
    let rows = $('tr')
    if (rows.length === 0) {
      rows = $('div[class*="row"], div[class*="item"], div[class*="product"]')
    }

    itemElements = rows.filter((_i, el) => {
      const hasImg = $(el).find('img').length > 0
      const text = $(el).text()
      // Relaxed price regex: allows $10 or $10.00
      const hasPrice = /\$\d+(?:,\d{3})*(?:\.\d{2})?/.test(text)
      // Avoid rows that look like totals/headers
      const isTotal = /Order total|Subtotal|Tax|Shipping|Order placed|Order #/i.test(text)
      return hasImg && hasPrice && !isTotal
    })
    if (itemElements.length > 0) strategy = 'generic-row'
  }

  if (itemElements.length === 0) {
    // Strategy 3: Last Resort - Find any image that looks like a product
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
      if (/logo|social|facebook|twitter|instagram|pinterest|youtube|spacer|pixel|tracker|analytics|bullseye/i.test(src)) return false
      if (/logo|social|facebook|twitter|instagram|pinterest|youtube|Target Logo/i.test(alt)) return false

      // Strong signals it IS a product
      if (src.includes('target.scene7.com') && !src.includes('bullseye') && !src.includes('Joy_')) return true

      // Product links in parent
      const parentLink = $(el).closest('a')
      if (parentLink.length > 0) {
        const href = parentLink.attr('href') || ''
        if (href.includes('/p/') || href.includes('/A-')) return true
      }

      // If no specific markers, rely on size but exclude very wide banners
      if (width > 0 && height > 0) {
        if (width < MIN_PRODUCT_IMAGE_SIZE || height < MIN_PRODUCT_IMAGE_SIZE) return false
        const ratio = width / height
        if (ratio > MIN_ASPECT_RATIO && ratio < MAX_ASPECT_RATIO) return true
        return false
      }

      // If no dimensions and no other signals, check DOM depth
      if ($(el).parents().length > MIN_DOM_DEPTH_FOR_HEURISTIC) return true

      return false
    })
    if (itemElements.length > 0) strategy = 'images-only'
  }

  console.log(`[Target Parser] Found ${itemElements.length} potential items using strategy: ${strategy}`)

  const processedNames = new Set<string>()

  itemElements.each((_, el) => {
    let name = ''
    let container: ReturnType<typeof $> = $(el)
    let quantity = 1
    let image = ''
    let price = 0

    if (strategy === 'class') {
      // For product-details or product-col-right, look for h2 > a pattern
      // Real Target products always have links - avoid plain h2 text which may capture footer elements
      const productLink = $(el).find('h2 a, h2 > a')
      let productHref = ''
      if (productLink.length > 0) {
        name = productLink.text().trim()
        productHref = productLink.attr('href') || ''
      }

      // Fallback: first anchor link with product-like href (must be a link, not plain text)
      if (!name) {
        const anchors = $(el).find('a')
        anchors.each((_i, anchor) => {
          const href = $(anchor).attr('href') || ''
          const text = $(anchor).text().trim()
          // Only accept anchors that look like product links
          if (text && (href.includes('/p/') || href.includes('/A-') || href.includes('target.com'))) {
            name = text
            productHref = href
            return false // break
          }
        })
      }

      // Extract quantity from "Qty: X" pattern
      const containerText = $(el).text()
      const qtyMatch = containerText.match(/Qty:?\s*(\d+)/i) || containerText.match(/Quantity:?\s*(\d+)/i)
      if (qtyMatch) {
        quantity = parseInt(qtyMatch[1], 10)
      }

      // Extract price from "$X.XX / ea" pattern
      const priceMatch = containerText.match(/\$(\d{1,3}(?:,\d{3})*\.\d{2})\s*\/\s*ea/i)
      if (priceMatch) {
        price = parseFloat(priceMatch[1].replace(/,/g, ''))
      } else {
        // Try to find any price
        const anyPriceMatch = containerText.match(/\$(\d{1,3}(?:,\d{3})*\.\d{2})/)
        if (anyPriceMatch) {
          price = parseFloat(anyPriceMatch[1].replace(/,/g, ''))
        }
      }

      // Get image from sibling product-col-left
      const parentRow = $(el).closest('tr')
      if (parentRow.length > 0) {
        const leftCol = parentRow.find('td.product-col-left, td[class*="product-col-left"]')
        if (leftCol.length > 0) {
          const img = leftCol.find('img').first()
          if (img.length > 0) {
            image = img.attr('src') || ''
          }
        }
      }

      // Fallback: find image in same row
      if (!image && parentRow.length > 0) {
        const img = parentRow.find('img').first()
        if (img.length > 0) {
          image = img.attr('src') || ''
        }
      }

      // Fallback: find an anchor with the same href as the product link and look for img inside
      if (!image && productHref) {
        const matchingLinks = $(`a[href="${productHref}"]`)
        matchingLinks.each((_i, link) => {
          const img = $(link).find('img').first()
          if (img.length > 0) {
            const src = img.attr('src') || ''
            // Prefer target.scene7.com images (product images)
            if (src.includes('target.scene7.com')) {
              image = src
              return false // break
            }
          }
        })
        // If no scene7 image found, try any image in matching links
        if (!image) {
          matchingLinks.each((_i, link) => {
            const img = $(link).find('img').first()
            if (img.length > 0) {
              image = img.attr('src') || ''
              return false // break
            }
          })
        }
      }

      // Fallback: search for img with matching alt text (product name)
      if (!image && name) {
        const allImages = $('img')
        allImages.each((_i, img) => {
          const alt = $(img).attr('alt') || ''
          // Check if alt contains the product name (case insensitive, partial match)
          if (alt && name && alt.toLowerCase().includes(name.toLowerCase().substring(0, 20))) {
            const src = $(img).attr('src') || ''
            if (src.includes('target.scene7.com')) {
              image = src
              return false // break
            }
          }
        })
      }

      // Fallback: look in parent table for target.scene7.com images
      if (!image) {
        const parentTable = $(el).closest('table')
        if (parentTable.length > 0) {
          const imgs = parentTable.find('img[src*="target.scene7.com"]')
          imgs.each((_i, img) => {
            const src = $(img).attr('src') || ''
            // Exclude known non-product images
            if (!src.includes('bullseye') && !src.includes('Joy_') && !src.includes('logo')) {
              image = src
              return false // break
            }
          })
        }
      }

      container = parentRow.length > 0 ? parentRow : $(el).closest('table')

    } else if (strategy === 'link') {
      // Get name from link text or title
      name = $(el).text().trim()
      if (!name) {
        name = $(el).attr('title') || ''
      }
      if (!name) {
        const img = $(el).find('img')
        if (img.length > 0) {
          name = img.attr('alt') || ''
        }
      }

      container = $(el).closest('tr')
      if (container.length === 0) container = $(el).closest('div')

    } else if (strategy === 'generic-row') {
      container = $(el)

      // Look for product name in anchor or heading
      const anchor = container.find('a').first()
      if (anchor.length) {
        name = anchor.text().trim()
      }

      if (!name) {
        const heading = container.find('h2, h3').first()
        if (heading.length) {
          name = heading.text().trim()
        }
      }

      if (!name) {
        name = container.find('span, div, p').first().text().trim()
      }
      if (!name) name = container.text().trim().split('\n')[0]

    } else if (strategy === 'images-only') {
      // Get name from alt text
      name = $(el).attr('alt') || ''

      // Try title of parent link
      if (!name) name = $(el).closest('a').attr('title') || ''

      // Look in parent container for text
      if (!name) {
        let parent = $(el).parent()
        name = parent.text().trim().split('\n')[0]

        if (!name || /^\$|Qty/.test(name)) {
          parent = parent.parent()
          const text = parent.text().trim()
          const lines = text.split('\n').map(l => l.trim()).filter(l => l)
          for (const line of lines) {
            if (!/^\$|Qty|Arrives|Sold by|Return|Track/.test(line) && line.length > 3) {
              name = line
              break
            }
          }
        }
      }

      container = $(el).closest('tr')
      if (container.length === 0) container = $(el).closest('div[class*="row"], div[class*="item"]')
      if (container.length === 0) container = $(el).parent().parent()
    }

    if (!name) return

    // Clean up name
    name = name.replace(/\s+/g, ' ').trim()

    // Decode HTML entities (e.g., &#233; -> e, &#233; -> e for Pokemon)
    name = $('<div>').html(name).text()

    // Remove common verbose prefixes
    name = name.replace(/^Pokémon Trading Card Game\s*:\s*/i, '')
    name = name.replace(/^Scarlet & Violet—\s*/i, '')

    if (name.length > 100) name = name.substring(0, 100) + '...'

    // Deduplicate
    if (processedNames.has(name)) return
    processedNames.add(name)

    // Filter out items that appear after "Order total" (likely marketing/recommendation)
    if (orderTotalIndex !== -1) {
      const itemHtml = $.html(el)
      const itemIndex = fullHtml.indexOf(itemHtml)
      if (itemIndex !== -1 && itemIndex > orderTotalIndex) {
        return
      }
    }

    // Extract price and quantity if not already found
    if (container.length > 0 && (price === 0 || quantity === 1)) {
      const containerText = container.text()

      // Extract quantity
      if (quantity === 1) {
        const qtyMatch = containerText.match(/Qty:?\s*(\d+)/i) || containerText.match(/Quantity:?\s*(\d+)/i)
        if (qtyMatch) {
          quantity = parseInt(qtyMatch[1], 10)
        }
      }

      // Extract price
      if (price === 0) {
        // First try the per-item price pattern
        const perItemMatch = containerText.match(/\$(\d{1,3}(?:,\d{3})*\.\d{2})\s*\/\s*ea/i)
        if (perItemMatch) {
          price = parseFloat(perItemMatch[1].replace(/,/g, ''))
        } else {
          // Search up the tree for a price
          let priceContainer = container
          let priceFound = false
          let attempts = 0

          while (!priceFound && attempts < 5 && priceContainer.length > 0 && (priceContainer[0] as { tagName?: string }).tagName !== 'body') {
            const text = priceContainer.text()
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
      }

      // Extract image if not found
      if (!image) {
        const img = container.find('img').first()
        if (img.length) {
          image = img.attr('src') || ''
        }
      }
    }

    items.push({
      name,
      price,
      quantity,
      image: image || PLACEHOLDER_IMAGE
    })
  })

  // Post-processing: Fallback for price if 0
  if (items.length === 1 && items[0].price === 0 && total > 0) {
    items[0].price = total
  }

  // Strategy 4: Unknown Product fallback
  // When no items found but order is valid, create placeholder entry
  // This handles cancellation emails that don't list products
  if (items.length === 0 && orderId) {
    let itemCount = 1

    // Look for "X items" pattern in the email
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

    console.log(`[Target Parser] No items found, using Unknown Product fallback with quantity: ${itemCount}`)
  }

  console.log(`[Target Parser] Parsed ${items.length} items from order ${orderId}`)

  return {
    id: orderId,
    date: orderDate.toISOString(),
    retailer: 'Target',
    items,
    total,
    status
  }
}
