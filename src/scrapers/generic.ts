import { BrowserContext } from 'playwright'
import { ScrapeResult } from './base'

export async function scrapeGeneric(url: string, ctx: BrowserContext): Promise<ScrapeResult> {
  const page = await ctx.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    const data = await page.evaluate(() => ({
      title: document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title || null,
      image: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
    }))
    return {
      marketplace: 'generic',
      title: data.title,
      price: null,
      originalPrice: null,
      pixPrice: null,
      discountPercent: 0,
      image: data.image,
      currency: 'BRL',
      success: !!(data.title)
    }
  } catch (err: any) {
    return {
      marketplace: 'generic',
      title: null,
      price: null,
      originalPrice: null,
      pixPrice: null,
      discountPercent: 0,
      image: null,
      currency: 'BRL',
      success: false,
      error: err.message
    }
  } finally {
    await page.close()
  }
}
