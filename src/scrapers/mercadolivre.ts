import { BrowserContext } from 'playwright'
import { ScrapeResult } from './base'

export async function scrapeMercadoLivre(url: string, ctx: BrowserContext): Promise<ScrapeResult> {
  // Limpa query string
  const cleanUrl = (() => {
    try {
      const u = new URL(url)
      u.search = ''
      u.hash = ''
      return u.toString()
    } catch { return url }
  })()

  const page = await ctx.newPage()

  try {
    await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 25000 })

    // Aguarda preço renderizar (e aguarda redirecionamento se houver challenge)
    await page.waitForSelector(
      '.andes-money-amount__fraction, [class*="price-tag-fraction"]',
      { timeout: 20000 }
    ).catch(() => null)

    const data = await page.evaluate(() => {
      // Título
      const title =
        document.querySelector('h1.ui-pdp-title')?.textContent?.trim() ||
        document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
        null

      // Preço
      const priceEl = document.querySelector('.andes-money-amount__fraction')
      const priceCentsEl = document.querySelector('.andes-money-amount__cents')
      let price: number | null = null
      if (priceEl) {
        const raw = priceEl.textContent?.replace(/\./g, '').replace(',', '.').trim() || ''
        const cents = priceCentsEl?.textContent?.trim() || '00'
        const parsed = parseFloat(`${raw}.${cents}`)
        price = isNaN(parsed) ? null : parsed
      }

      // Imagem
      const image =
        document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
        document.querySelector('.ui-pdp-image')?.getAttribute('src') ||
        null

      return { title, price, image }
    })

    return {
      marketplace: 'mercadolivre',
      title: data.title,
      price: data.price,
      image: data.image,
      currency: 'BRL',
      success: !!(data.title)
    }
  } catch (err: any) {
    return {
      marketplace: 'mercadolivre',
      title: null,
      price: null,
      image: null,
      currency: 'BRL',
      success: false,
      error: err.message
    }
  } finally {
    await page.close()
  }
}
