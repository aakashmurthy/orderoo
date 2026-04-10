# Orderoo — Walmart & Target IMAP Order Scraper

A desktop app that scrapes Walmart and Target order confirmation emails via IMAP and tracks your purchases locally. Connect any Gmail, iCloud, or custom IMAP email account — no cloud, no accounts, no subscriptions.

![Dashboard showing order stats](logo.png)

## What it does

- **IMAP order scraper** — connects to your email and scans for Walmart/Target order emails
- Scrapes order confirmation emails from Walmart and Target (quantities, prices, items, status)
- Detects cancelled orders automatically from cancellation emails
- Shows a daily dashboard with stats: total orders, cancelled orders, stick rate, quantity, and spend
- Stores everything in a plain `storage.json` file on your computer — no cloud, no accounts

## Supported Retailers

Orderoo scrapes order emails from these retailers via IMAP:

| Retailer | Order Confirmations | Cancellations |
|----------|-------------------|---------------|
| Walmart  | Yes               | Yes           |
| Target   | Yes               | Yes           |

More retailers can be added using the built-in `/scraper` skill (see below).

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- [Git](https://git-scm.com/)
- A Gmail or iCloud email account (or any IMAP-enabled email account) with Walmart or Target order emails in your inbox

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/aakashmurthy/orderoo.git
cd orderoo

# 2. Install dependencies
npm install

# 3. Start the app
npm run dev
```

That's it. The app window will open automatically.

## Setting Up Your Email

Orderoo uses **IMAP** to read your emails and scrape Walmart/Target order confirmations. You'll need to create an **App Password** — a special one-time password that lets the app connect without using your real password.

### Gmail

1. Go to your Google Account → **Security**
2. Under "How you sign in to Google", enable **2-Step Verification** if not already on
3. Search for **App Passwords** in the search bar
4. Create a new app password (name it anything, e.g. "Orderoo")
5. Copy the 16-character password

### iCloud

1. Go to [appleid.apple.com](https://appleid.apple.com)
2. Sign in → **Sign-In and Security** → **App-Specific Passwords**
3. Click **+** to generate a new password (name it "Orderoo")
4. Copy the password

### Adding your account in Orderoo

1. Open the **Accounts** tab in the app
2. Click **Add Account**
3. Select your provider (Gmail / iCloud / Custom)
4. Enter your email address and the App Password you just created
5. Click **Test Connection** to verify it works
6. Save the account

## Using the App

1. Go to the **Dashboard** tab
2. Use the date filter to select a time range (e.g. "Last 30 days")
3. Click **Scrape** — the app will scan your emails and pull in orders
4. Orders appear in the table below the stats

The scrape can take a minute or two depending on how many emails you have.

## Your Data

All data is stored locally in `storage.json` in the app folder. You can open it with any text editor to see your orders and accounts.

```json
{
  "orders": [
    {
      "id": "123456789",
      "retailer": "Walmart",
      "date": "2024-01-15",
      "status": "placed",
      "total": 49.99,
      "items": [...]
    }
  ],
  "accounts": [...]
}
```

> **Note:** Your email password is stored in this file. Keep the file private and do not share it.

## Building for Production

```bash
npm run build
```

This creates an installable `.exe` (Windows) in the `release/` folder.

## Adding Support for New Retailers

Orderoo includes a `/scraper` skill for Claude Code that generates a complete retailer parser from sample emails.

### Requirements

- [Claude Code](https://claude.ai/code) installed
- One or more sample `.eml` files from the retailer (order confirmation + cancellation)

### Usage

1. Save sample emails as `.eml` files into the `email-examples/` directory
2. Open Claude Code in this project and run:

```
/scraper Add [Retailer] parser — order: email-examples/[retailer]-order.eml, cancel: email-examples/[retailer]-cancel.eml
```

Claude will generate:
- `electron/parsers/[retailer].ts` — email parser with multi-strategy extraction
- Updates to `electron/imap.ts` — routing and IMAP search filters
- Updates to `src/App.tsx` — adds retailer to the dashboard filter UI

You'll still need to manually add a logo image to `public/logos/[retailer].png`.

### How to get `.eml` files

- **Gmail**: Open the email → three-dot menu → *Download message*
- **Apple Mail**: Drag the email to Finder, or File → Save As
- **Outlook**: File → Save As → choose `.eml` or `.msg` format

See [CLAUDE.md](CLAUDE.md#adding-new-retailers) for the full parser reference and best practices.

## Troubleshooting

**The app won't connect to my email**
- Double-check you're using an App Password, not your real account password
- For Gmail, make sure IMAP is enabled: Gmail Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP

**No orders are showing up**
- Make sure you clicked **Scrape** after adding your account
- Try widening the date filter (e.g. "All time")
- Check that your order confirmation emails are in your inbox and not filtered/archived

**Build fails**
- Run `npm install` again
- Make sure you have Node.js 18+: `node --version`

## License

MIT
