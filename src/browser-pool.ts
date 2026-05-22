import { chromium, Browser, BrowserContext } from 'playwright'

export class BrowserPool {
  private browsers: Browser[] = []
  private queue: Array<(ctx: BrowserContext) => void> = []
  private available: BrowserContext[] = []
  private size: number

  constructor(size: number) {
    this.size = size
  }

  async initialize() {
    for (let i = 0; i < this.size; i++) {
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      })
      this.browsers.push(browser)
      const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'pt-BR',
        extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9' }
      })

      // Evasão de detecção de robôs / headless
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        })
      })

      this.available.push(ctx)
    }
  }

  async acquire(): Promise<BrowserContext> {
    if (this.available.length > 0) {
      return this.available.pop()!
    }
    return new Promise(resolve => this.queue.push(resolve))
  }

  release(ctx: BrowserContext) {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next(ctx)
    } else {
      this.available.push(ctx)
    }
  }

  async shutdown() {
    for (const browser of this.browsers) {
      await browser.close().catch(() => null)
    }
  }
}
