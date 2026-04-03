import { useState, useEffect, useMemo, Component, type ReactNode } from 'react'
import DOMPurify from 'dompurify'
import './App.css'
import type { Order, Account, ScrapeProgress, EmailContent, TestConnectionResult } from './types'

// Use the typed electronAPI exposed by the preload script
const { electronAPI } = window

/**
 * Supported retailers - add new retailers here when parsers are added
 * Logo files should be placed in public/logos/ with lowercase names
 */
const SUPPORTED_RETAILERS = ['Walmart', 'Target'] as const
type Retailer = typeof SUPPORTED_RETAILERS[number]

const RETAILER_LOGOS: Record<Retailer, string> = {
  Walmart: './logos/walmart.png',
  Target: './logos/target.webp',
}

/**
 * Coming soon retailers - displayed as greyed out in the filter bar
 */
const COMING_SOON_RETAILERS = ['Costco', "Sam's Club", 'Best Buy'] as const
type ComingSoonRetailer = typeof COMING_SOON_RETAILERS[number]

const COMING_SOON_LOGOS: Record<ComingSoonRetailer, string> = {
  Costco: './logos/costco.webp',
  "Sam's Club": './logos/sams.webp',
  'Best Buy': './logos/best buy.webp',
}

/**
 * Error Boundary Component
 * Catches rendering errors and displays a fallback UI
 */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error Boundary caught an error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 max-w-2xl w-full border border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3 mb-4">
              <span className="text-4xl">⚠️</span>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                Something went wrong
              </h1>
            </div>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              The application encountered an unexpected error. Please try refreshing the page.
            </p>
            {this.state.error && (
              <details className="mb-4">
                <summary className="cursor-pointer text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">
                  Error details
                </summary>
                <pre className="mt-2 p-4 bg-gray-100 dark:bg-gray-900 rounded text-xs overflow-auto text-gray-800 dark:text-gray-200">
                  {this.state.error.toString()}
                  {this.state.error.stack}
                </pre>
              </details>
            )}
            <button
              onClick={() => window.location.reload()}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium transition-colors"
            >
              Reload Application
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'accounts'>('dashboard')
  const [orders, setOrders] = useState<Order[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(false)
  const [scrapeProgress, setScrapeProgress] = useState<ScrapeProgress | null>(null)
  const [selectedDate, setSelectedDate] = useState('')
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [darkMode, setDarkMode] = useState(true)
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null)
  const [scrapeMode, setScrapeMode] = useState<'today' | 'last-week' | 'ytd' | 'from-date' | 'all'>('today')
  const [scrapeDate, setScrapeDate] = useState(new Date().toISOString().split('T')[0])
  const [sortField, setSortField] = useState<'lastOrderDate' | 'totalOrders' | 'cancelled' | 'stuck' | 'stickRate' | 'quantity' | 'totalSpent' | null>(null)
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [orderEmails, setOrderEmails] = useState<EmailContent[]>([])
  const [loadingEmails, setLoadingEmails] = useState(false)
  const [enabledRetailers, setEnabledRetailers] = useState<Set<Retailer>>(new Set(SUPPORTED_RETAILERS))
  const [testingConnection, setTestingConnection] = useState<string | null>(null)
  const [connectionTestResult, setConnectionTestResult] = useState<{ accountId: string; result: TestConnectionResult } | null>(null)

  useEffect(() => {
    void loadData()
  }, [])

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [darkMode])

  // Listen for scrape progress updates
  useEffect(() => {
    const cleanup = electronAPI.onScrapeProgress((progress) => {
      setScrapeProgress(progress)
    })
    return cleanup
  }, [])

  const loadData = async () => {
    try {
      const loadedOrders = await electronAPI.getOrders()
      const loadedAccounts = await electronAPI.getAccounts()
      setOrders(loadedOrders)
      setAccounts(loadedAccounts)
    } catch (error) {
      console.error('Failed to load data:', error)
    }
  }

  const handleDeleteAccount = async (id: string) => {
    if (confirm('Are you sure you want to delete this account?')) {
      try {
        await electronAPI.deleteAccount(id)
        await loadData()
      } catch (error) {
        console.error('Failed to delete account:', error)
      }
    }
  }

  const handleTestConnection = async (account: Account) => {
    setTestingConnection(account.id)
    setConnectionTestResult(null)
    try {
      const result = await electronAPI.testConnection(account)
      setConnectionTestResult({ accountId: account.id, result })
    } catch (error) {
      console.error('Test connection error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to test connection'
      setConnectionTestResult({
        accountId: account.id,
        result: { success: false, error: errorMessage }
      })
    } finally {
      setTestingConnection(null)
    }
  }

  const handleClearOrders = async () => {
    if (confirm('Are you sure you want to clear all orders? This cannot be undone.')) {
      try {
        await electronAPI.clearOrders()
        await loadData()
      } catch (error) {
        console.error('Failed to clear orders:', error)
      }
    }
  }

  const handleScrape = async () => {
    setLoading(true)
    setScrapeProgress(null)
    try {
      let dateFilter: string | undefined
      if (scrapeMode === 'today') {
        dateFilter = new Date().toISOString().split('T')[0]
      } else if (scrapeMode === 'last-week') {
        // Last 7 days
        const lastWeek = new Date()
        lastWeek.setDate(lastWeek.getDate() - 7)
        dateFilter = lastWeek.toISOString().split('T')[0]
      } else if (scrapeMode === 'ytd') {
        // Year to date: January 1st of current year
        dateFilter = `${new Date().getFullYear()}-01-01`
      } else if (scrapeMode === 'from-date') {
        dateFilter = scrapeDate
      }
      // 'all' mode: dateFilter remains undefined (no filter)
      await electronAPI.scrapeAll(dateFilter)
      await loadData()
    } catch (error) {
      console.error('Failed to scrape:', error)
    } finally {
      setScrapeProgress(null)
      setLoading(false)
    }
  }

  const handleViewOrderEmails = async (orderId: string) => {
    setSelectedOrderId(orderId)
    setLoadingEmails(true)
    setOrderEmails([])
    try {
      const emails = await electronAPI.fetchOrderEmails(orderId)
      setOrderEmails(emails)
    } catch (error) {
      console.error('Error fetching order emails:', error)
    }
    setLoadingEmails(false)
  }

  const closeEmailViewer = () => {
    setSelectedOrderId(null)
    setOrderEmails([])
  }

  // Close email viewer modal on Escape key
  useEffect(() => {
    if (!selectedOrderId) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeEmailViewer()
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [selectedOrderId])

  const toggleRetailer = (retailer: Retailer) => {
    setEnabledRetailers(prev => {
      const next = new Set(prev)
      if (next.has(retailer)) {
        next.delete(retailer)
      } else {
        next.add(retailer)
      }
      return next
    })
  }

  const filteredOrders = useMemo(() => orders.filter(order => {
    // Filter by retailer
    if (!enabledRetailers.has(order.retailer as Retailer)) return false
    // Filter by date
    if (!selectedDate) return true
    const orderDate = new Date(order.date).toLocaleDateString('en-CA')
    return orderDate === selectedDate
  }), [orders, enabledRetailers, selectedDate])

  const productStats = useMemo(() => {
    const stats: Record<string, {
      name: string
      image: string
      retailer: string
      totalOrders: number
      cancelled: number
      quantity: number
      totalSpent: number
      lastOrderDate: string
    }> = {}

    filteredOrders.forEach(order => {
      order.items.forEach(item => {
        const key = `${order.retailer}:${item.name}`
        const name = item.name
        if (!stats[key]) {
          stats[key] = {
            name,
            image: item.image || '',
            retailer: order.retailer,
            totalOrders: 0,
            cancelled: 0,
            quantity: 0,
            totalSpent: 0,
            lastOrderDate: order.date
          }
        }

        stats[key].totalOrders += 1

        // Track most recent order date
        if (order.date > stats[key].lastOrderDate) {
          stats[key].lastOrderDate = order.date
        }

        if (order.status === 'cancelled') {
          stats[key].cancelled += 1
        } else {
          stats[key].quantity += item.quantity

          // Calculate item total cost
          let itemCost = item.price

          // Fallback: If price is 0 and it's the only item in the order, use the order total
          if (itemCost === 0 && order.items.length === 1) {
            itemCost = order.total
          }

          // Heuristic: If the price looks like a unit price (e.g. price * qty = total), multiply it
          // Only apply if we have a valid price and it's the only item (to be safe)
          if (item.price > 0 && order.items.length === 1 && item.quantity > 1) {
             const potentialTotal = item.price * item.quantity
             if (Math.abs(potentialTotal - order.total) < 0.1) {
                 itemCost = potentialTotal
             }
          }

          stats[key].totalSpent += itemCost
        }

        if (!stats[key].image && item.image) {
            stats[key].image = item.image
        }
      })
    })

    return Object.values(stats).map(stat => ({
      ...stat,
      stuck: stat.totalOrders - stat.cancelled,
      stickRate: stat.totalOrders > 0 ? ((stat.totalOrders - stat.cancelled) / stat.totalOrders) * 100 : 0
    }))
  }, [filteredOrders])

  // Update page title when viewing a product
  useEffect(() => {
    if (selectedProduct) {
      const stat = productStats.find(s => s.name === selectedProduct)
      const retailer = stat?.retailer || 'Unknown'
      document.title = `${selectedProduct} at ${retailer}`
    } else {
      document.title = 'Orderoo'
    }
  }, [selectedProduct, productStats])

  const sortedProductStats = useMemo(() => {
    const sorted = [...productStats]
    const field = sortField || 'lastOrderDate' // Default to most recent
    const dir = sortField ? sortDirection : 'desc' // Default descending for most recent

    sorted.sort((a, b) => {
      let aVal = a[field]
      let bVal = b[field]

      if (typeof aVal === 'string') {
        aVal = aVal.toLowerCase()
        bVal = (bVal as string).toLowerCase()
      }

      if (aVal < bVal) return dir === 'asc' ? -1 : 1
      if (aVal > bVal) return dir === 'asc' ? 1 : -1
      return 0
    })

    return sorted
  }, [productStats, sortField, sortDirection])

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) {
      // If already sorting by this field, toggle direction or clear
      if (sortDirection === 'desc') {
        setSortDirection('asc')
      } else {
        // Clear sorting, return to default (most recent)
        setSortField(null)
        setSortDirection('desc')
      }
    } else {
      // New field, start with descending
      setSortField(field)
      setSortDirection('desc')
    }
  }

  const stats = useMemo(() => {
    const totalOrders = filteredOrders.length
    const cancelledOrders = filteredOrders.filter(o => o.status === 'cancelled').length
    const stickRate = totalOrders > 0 ? ((totalOrders - cancelledOrders) / totalOrders) * 100 : 0
    const totalQuantity = filteredOrders.reduce((acc, o) => acc + o.items.reduce((iAcc, i) => iAcc + i.quantity, 0), 0)
    const totalSpent = filteredOrders.reduce((acc, o) => acc + (o.status === 'placed' ? o.total : 0), 0)

    return { totalOrders, cancelledOrders, stickRate, totalQuantity, totalSpent }
  }, [filteredOrders])

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100 font-sans transition-colors duration-200">
      <nav className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex justify-between items-center">
        <div className="flex gap-4">
          <button 
            onClick={() => setActiveTab('dashboard')}
            className={`px-4 py-2 rounded-md font-medium transition-colors ${
              activeTab === 'dashboard' 
                ? 'bg-blue-600 text-white' 
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            Dashboard
          </button>
          <button 
            onClick={() => setActiveTab('accounts')}
            className={`px-4 py-2 rounded-md font-medium transition-colors ${
              activeTab === 'accounts' 
                ? 'bg-blue-600 text-white' 
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            Accounts
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400">v{__APP_VERSION__}</span>
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="p-2 rounded-md text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
          >
            {darkMode ? '☀️' : '🌙'}
          </button>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {activeTab === 'dashboard' && (
          selectedProduct ? (
            <div className="space-y-6">
              <div className="flex items-center gap-4">
                <button 
                  onClick={() => setSelectedProduct(null)}
                  className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors text-gray-600 dark:text-gray-300"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                  </svg>
                </button>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                  {selectedProduct} @ {productStats.find(s => s.name === selectedProduct)?.retailer || 'Unknown'}
                </h1>
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden border border-gray-200 dark:border-gray-700">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-700">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Date</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Order ID</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Status</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Qty</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Item Price</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Order Total</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                      {filteredOrders
                        .filter(order => order.items.some(item => item.name === selectedProduct))
                        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                        .map(order => {
                          const item = order.items.find(i => i.name === selectedProduct)
                          return (
                            <tr
                              key={order.id}
                              onClick={() => void handleViewOrderEmails(order.id)}
                              className="hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                            >
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                {new Date(order.date).toLocaleDateString()}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 font-mono">
                                {order.id}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm">
                                <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                  order.status === 'placed' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' :
                                  'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                                }`}>
                                  {order.status}
                                </span>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                {item?.quantity || 0}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                ${item?.price.toFixed(2)}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                ${order.total.toFixed(2)}
                              </td>
                            </tr>
                          )
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
          <div className="space-y-8">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
              <div className="flex gap-3 items-center bg-white dark:bg-gray-800 p-2 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2 border-r border-gray-200 dark:border-gray-600 pr-3">
                  <label className="text-xs text-gray-500 dark:text-gray-400">Filter:</label>
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="border-gray-300 dark:border-gray-600 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500 px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                  <button
                    onClick={() => setSelectedDate('')}
                    className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2"
                  >
                    Clear
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={scrapeMode}
                    onChange={(e) => setScrapeMode(e.target.value as 'today' | 'last-week' | 'ytd' | 'from-date' | 'all')}
                    className="border-gray-300 dark:border-gray-600 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500 px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  >
                    <option value="today">Today</option>
                    <option value="last-week">Last Week</option>
                    <option value="ytd">Year to Date</option>
                    <option value="from-date">From Date</option>
                    <option value="all">All Time</option>
                  </select>
                  {scrapeMode === 'from-date' && (
                    <input
                      type="date"
                      value={scrapeDate}
                      onChange={(e) => setScrapeDate(e.target.value)}
                      className="border-gray-300 dark:border-gray-600 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500 px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                    />
                  )}
                  <button
                    onClick={() => void handleScrape()}
                    disabled={loading}
                    className={`px-4 py-2 rounded-md text-sm font-medium text-white transition-colors ${
                      loading ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    {loading ? 'Scraping...' : 'Scrape'}
                  </button>
                </div>
              </div>
            </div>

            {/* Scrape Progress Bar */}
            {loading && scrapeProgress && (
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Account {scrapeProgress.currentAccount} of {scrapeProgress.totalAccounts}
                  </span>
                  <span className="text-sm text-gray-500 dark:text-gray-400 truncate ml-4 max-w-xs">
                    {scrapeProgress.accountEmail}
                  </span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 mb-3">
                  <div
                    className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                    style={{ width: `${(scrapeProgress.currentAccount / scrapeProgress.totalAccounts) * 100}%` }}
                  />
                </div>
                {scrapeProgress.totalMessages > 0 && (
                  <>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        Processing email {scrapeProgress.currentMessage} of {scrapeProgress.totalMessages}
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                      <div
                        className="bg-green-500 h-1.5 rounded-full transition-all duration-150"
                        style={{ width: `${(scrapeProgress.currentMessage / scrapeProgress.totalMessages) * 100}%` }}
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Retailer Filter Buttons */}
            <div className="flex gap-2">
              {SUPPORTED_RETAILERS.map(retailer => (
                <button
                  key={retailer}
                  onClick={() => toggleRetailer(retailer)}
                  className={`flex-1 px-4 py-3 rounded-lg font-medium text-sm transition-all duration-200 border flex flex-col items-center gap-1.5 ${
                    enabledRetailers.has(retailer)
                      ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700 shadow-sm'
                      : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 opacity-60'
                  }`}
                >
                  <img
                    src={RETAILER_LOGOS[retailer]}
                    alt={`${retailer} logo`}
                    className="w-8 h-8 object-contain rounded"
                  />
                  {retailer}
                </button>
              ))}
              {/* Coming Soon Retailers */}
              {COMING_SOON_RETAILERS.map(retailer => (
                <div
                  key={retailer}
                  className="flex-1 px-4 py-3 rounded-lg font-medium text-sm border flex flex-col items-center gap-1.5 bg-gray-100 dark:bg-gray-800/50 text-gray-400 dark:text-gray-500 border-gray-200 dark:border-gray-700 opacity-50 cursor-not-allowed"
                  title="Coming Soon"
                >
                  <img
                    src={COMING_SOON_LOGOS[retailer]}
                    alt={`${retailer} logo`}
                    className="w-8 h-8 object-contain rounded grayscale"
                  />
                  <span>{retailer}</span>
                  <span className="text-[10px] uppercase tracking-wide">Coming Soon</span>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <StatCard title="Total Orders" value={stats.totalOrders} />
              <StatCard title="Cancelled" value={stats.cancelledOrders} />
              <StatCard title="Stick Rate" value={`${stats.stickRate.toFixed(1)}%`} />
              <StatCard title="Total Qty" value={stats.totalQuantity} />
              <StatCard title="Total Spent" value={`$${stats.totalSpent.toFixed(2)}`} />
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden border border-gray-200 dark:border-gray-700">
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Product Breakdown</h2>
                <button
                  onClick={() => void handleClearOrders()}
                  className="px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 border border-red-300 dark:border-red-600 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                >
                  Clear Orders
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-700">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Retailer</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Product</th>
                      <th
                        onClick={() => handleSort('stuck')}
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 select-none"
                      >
                        Stuck {sortField === 'stuck' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}
                      </th>
                      <th
                        onClick={() => handleSort('cancelled')}
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 select-none"
                      >
                        Cancelled {sortField === 'cancelled' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}
                      </th>
                      <th
                        onClick={() => handleSort('totalOrders')}
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 select-none"
                      >
                        Total {sortField === 'totalOrders' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}
                      </th>
                      <th
                        onClick={() => handleSort('stickRate')}
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 select-none"
                      >
                        Stick Rate {sortField === 'stickRate' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}
                      </th>
                      <th
                        onClick={() => handleSort('quantity')}
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 select-none"
                      >
                        Quantity {sortField === 'quantity' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}
                      </th>
                      <th
                        onClick={() => handleSort('totalSpent')}
                        className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 select-none"
                      >
                        Total Spent {sortField === 'totalSpent' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                    {sortedProductStats.map((stat) => (
                      <tr
                        key={`${stat.retailer}:${stat.name}`}
                        onClick={() => setSelectedProduct(stat.name)}
                        className="hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer transition-colors"
                      >
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                          <img
                            src={RETAILER_LOGOS[stat.retailer as Retailer]}
                            alt={stat.retailer}
                            className="w-6 h-6 object-contain"
                          />
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                          <div className="flex items-center gap-3">
                            {stat.image ? (
                              <img src={stat.image} alt={stat.name} className="w-10 h-10 object-cover rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700" />
                            ) : (
                              <div className="w-10 h-10 bg-gray-100 dark:bg-gray-700 rounded border border-gray-200 dark:border-gray-600 flex items-center justify-center text-xs text-gray-400">No img</div>
                            )}
                            <span className="font-medium truncate max-w-xs" title={stat.name}>{stat.name}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-green-600 dark:text-green-400">{stat.stuck}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-red-600 dark:text-red-400">{stat.cancelled}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">{stat.totalOrders}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                          <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                            stat.stickRate >= 80 ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' :
                            stat.stickRate >= 50 ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300' :
                            'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                          }`}>
                            {stat.stickRate.toFixed(1)}%
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">{stat.quantity}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-gray-100">${stat.totalSpent.toFixed(2)}</td>
                      </tr>
                    ))}
                    {productStats.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-6 py-8 text-center text-gray-500 dark:text-gray-400 text-sm">
                          No products found for this period.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          )
        )}

        {activeTab === 'accounts' && (
          <div className="max-w-3xl mx-auto space-y-8">
            <div className="flex justify-between items-center">
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Accounts</h1>
            </div>
            
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
              <AccountForm
                accountToEdit={editingAccount}
                onSave={() => {
                  setEditingAccount(null)
                  void loadData()
                }}
                onCancel={() => setEditingAccount(null)}
              />
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700">
                <h2 className="text-lg font-medium text-gray-900 dark:text-white">Connected Accounts</h2>
              </div>
              <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                {accounts.map(acc => (
                  <li key={acc.id} className="px-6 py-4 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className={`text-sm font-medium ${acc.status === 'auth_error' ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}`}>{acc.email}</p>
                          {acc.status === 'auth_error' && (
                            <span title="Authentication Error: Please check your credentials" className="text-lg cursor-help">⚠️</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide mt-1">{acc.provider}</p>
                      </div>
                      <div className="flex gap-3">
                        <button
                          onClick={() => void handleTestConnection(acc)}
                          disabled={testingConnection === acc.id}
                          className="text-sm font-medium text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {testingConnection === acc.id ? 'Testing...' : 'Test'}
                        </button>
                        <button
                          onClick={() => setEditingAccount(acc)}
                          className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => void handleDeleteAccount(acc.id)}
                          className="text-sm font-medium text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {/* Connection test result message */}
                    {connectionTestResult && connectionTestResult.accountId === acc.id && (
                      <div className={`mt-2 text-sm px-3 py-2 rounded ${
                        connectionTestResult.result.success
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                          : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                      }`}>
                        {connectionTestResult.result.success
                          ? 'Connection successful! IMAP credentials are valid.'
                          : `Connection failed: ${connectionTestResult.result.error}`}
                      </div>
                    )}
                  </li>
                ))}
                {accounts.length === 0 && (
                  <li className="px-6 py-8 text-center text-gray-500 dark:text-gray-400 text-sm">
                    No accounts connected yet. Add one above.
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}
      </main>

      {/* Email Viewer Modal */}
      {selectedOrderId && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={closeEmailViewer}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Emails for Order #{selectedOrderId}
              </h2>
              <button
                onClick={closeEmailViewer}
                className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-auto p-6">
              {loadingEmails ? (
                <div className="flex items-center justify-center h-32">
                  <div className="text-gray-500 dark:text-gray-400">Loading emails...</div>
                </div>
              ) : orderEmails.length === 0 ? (
                <div className="flex items-center justify-center h-32">
                  <div className="text-gray-500 dark:text-gray-400">
                    No emails found. This order may need to be re-scraped to collect email IDs.
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  {orderEmails.map((email) => (
                    <div key={email.uid} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                      <div className="bg-gray-50 dark:bg-gray-700 px-4 py-3 border-b border-gray-200 dark:border-gray-600">
                        <div className="font-medium text-gray-900 dark:text-white">{email.subject}</div>
                        <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                          <span className="mr-4">From: {email.from}</span>
                          <span>{email.date ? new Date(email.date).toLocaleString() : ''}</span>
                        </div>
                      </div>
                      <div className="p-4 bg-white dark:bg-gray-800">
                        {email.html ? (
                          // sandbox="" with no allow-same-origin and no allow-scripts prevents
                          // the iframe content from executing scripts or accessing the parent page
                          <iframe
                            srcDoc={DOMPurify.sanitize(email.html, {
                              FORBID_TAGS: ['script', 'link', 'meta'],
                              FORBID_ATTR: [
                                'onerror', 'onload', 'onclick', 'onmouseover', 'onmouseout',
                                'onmouseenter', 'onmouseleave', 'onkeydown', 'onkeyup', 'onkeypress',
                                'oninput', 'onchange', 'onfocus', 'onblur', 'onsubmit', 'onreset'
                              ],
                              ALLOW_DATA_ATTR: false
                            })}
                            className="w-full h-96 border-0 bg-white"
                            title={`Email ${email.uid}`}
                            sandbox=""
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <pre className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">
                            {email.text}
                          </pre>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ title, value }: { title: string, value: string | number }) {
  return (
    <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
      <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">{title}</h3>
      <p className="text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
    </div>
  )
}

interface AccountFormProps {
  accountToEdit: Account | null
  onSave: () => void
  onCancel: () => void
}

function AccountForm({ accountToEdit, onSave, onCancel }: AccountFormProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [provider, setProvider] = useState<'icloud' | 'gmail' | 'custom'>('gmail')
  const [saving, setSaving] = useState(false)
  const [formTestResult, setFormTestResult] = useState<TestConnectionResult | null>(null)
  const [autoTesting, setAutoTesting] = useState(false)

  useEffect(() => {
    if (accountToEdit) {
      setEmail(accountToEdit.email)
      setProvider(accountToEdit.provider)
      setPassword('')
    } else {
      setEmail('')
      setProvider('gmail')
      setPassword('')
    }
    // Clear any previous test results when switching accounts
    setFormTestResult(null)
  }, [accountToEdit])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setFormTestResult(null)

    if (accountToEdit) {
       const updatedAccount = {
         ...accountToEdit,
         email,
         provider,
         password: password || undefined
       }
       await electronAPI.updateAccount(updatedAccount)
    } else {
      const account: Account = {
        id: crypto.randomUUID(),
        email,
        password,
        provider
      }
      await electronAPI.addAccount(account)

      // Auto-test connection for new accounts
      setAutoTesting(true)
      try {
        const result = await electronAPI.testConnection(account)
        setFormTestResult(result)
      } catch (error) {
        console.error('Auto-test connection error:', error)
        const errorMessage = error instanceof Error ? error.message : 'Failed to test connection'
        setFormTestResult({ success: false, error: errorMessage })
      }
      setAutoTesting(false)
    }

    setSaving(false)
    setEmail('')
    setPassword('')
    onSave()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-white">{accountToEdit ? 'Edit Account' : 'Add New Account'}</h3>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Provider</label>
          <select 
            value={provider} 
            onChange={(e) => setProvider(e.target.value as 'icloud' | 'gmail' | 'custom')}
            className="w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          >
            <option value="gmail">Gmail</option>
            <option value="icloud">iCloud</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email Address</label>
          <input 
            type="email" 
            placeholder="user@example.com" 
            value={email} 
            onChange={e => setEmail(e.target.value)} 
            required 
            className="w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          />
        </div>
        
        <div className="md:col-span-3">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {accountToEdit ? "New Password (leave blank to keep current)" : "App Password"}
          </label>
          <input 
            type="password" 
            placeholder="••••••••••••" 
            value={password} 
            onChange={e => setPassword(e.target.value)} 
            required={!accountToEdit} 
            className="w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Use an App Password, not your main account password.</p>
        </div>
      </div>

      {/* Auto-test result message for new accounts */}
      {formTestResult && (
        <div className={`text-sm px-3 py-2 rounded ${
          formTestResult.success
            ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
            : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
        }`}>
          {formTestResult.success
            ? 'Account added and connection verified successfully!'
            : `Account added, but connection test failed: ${formTestResult.error}`}
        </div>
      )}

      {/* Auto-testing indicator */}
      {autoTesting && (
        <div className="text-sm px-3 py-2 rounded bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
          Testing connection...
        </div>
      )}

      <div className="flex justify-end gap-3 pt-4">
        {accountToEdit && (
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={saving || autoTesting}
          className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : autoTesting ? 'Testing...' : accountToEdit ? 'Update Account' : 'Add Account'}
        </button>
      </div>
    </form>
  )
}

function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}

export default AppWithErrorBoundary
