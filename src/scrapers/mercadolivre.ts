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

      // 1. Preço original (riscado)
      const originalEl = document.querySelector('s.ui-pdp-price__original-value')
      const originalFraction = originalEl?.querySelector('.andes-money-amount__fraction')?.textContent?.replace(/\./g, '') || ''
      const originalCents = originalEl?.querySelector('.andes-money-amount__cents')?.textContent?.trim() || '00'
      const originalPrice = originalFraction ? parseFloat(`${originalFraction}.${originalCents}`) : null

      // 2. Preço Principal
      let mainPrice: number | null = null
      
      // Tentativa A: meta tag de preço dentro do schema
      const metaPrice = document.querySelector('meta[itemprop="price"]')?.getAttribute('content')
      if (metaPrice) {
        mainPrice = parseFloat(metaPrice)
      }
      
      // Tentativa B: elemento de preço (price-part container)
      if (!mainPrice) {
        const pricePartEl = document.querySelector('[data-testid="price-part"]') || document.querySelector('.ui-pdp-price__part__container')
        if (pricePartEl) {
          const fraction = pricePartEl.querySelector('.andes-money-amount__fraction')?.textContent?.replace(/\./g, '') || ''
          const cents = pricePartEl.querySelector('.andes-money-amount__cents')?.textContent?.trim() || '00'
          if (fraction) mainPrice = parseFloat(`${fraction}.${cents}`)
        }
      }

      // Tentativa C: fallback antigo para subtitles
      if (!mainPrice) {
        const subtitleText = document.querySelector('.ui-pdp-price__subtitles')?.textContent || ''
        const subtitleMatch = subtitleText.match(/ou R\$\s*([\d.]+(?:,\d{2})?)/) || subtitleText.match(/R\$\s*([\d.]+(?:,\d{2})?)/)
        const standardPriceRaw = subtitleMatch?.[1]?.replace(/\./g, '').replace(',', '.') || null
        if (standardPriceRaw) mainPrice = parseFloat(standardPriceRaw)
      }

      // 3. Preço no Pix (informativo, não usar como currentPrice)
      const pixEl = document.querySelector('.ui-pdp-price__second-line .andes-money-amount--weight-semibold')
      const pixFraction = pixEl?.querySelector('.andes-money-amount__fraction')?.textContent?.replace(/\./g, '') || ''
      const pixCents = pixEl?.querySelector('.andes-money-amount__cents')?.textContent?.trim() || '00'
      const pixPrice = pixFraction ? parseFloat(`${pixFraction}.${pixCents}`) : null

      // 4. Desconto
      const discountText = document.querySelector('.andes-money-amount__discount')?.textContent || ''
      const discountMatch = discountText.match(/(\d+)%/)
      const discountPercent = discountMatch ? parseInt(discountMatch[1]) : 0

      // Lógica de preço final: prefere mainPrice, fallback para Pix, fallback para original
      const price = mainPrice ?? pixPrice ?? originalPrice

      // Imagem
      const image =
        document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
        document.querySelector('.ui-pdp-image')?.getAttribute('src') ||
        null

      return { title, price, originalPrice, pixPrice, discountPercent, image }
    })

    return {
      marketplace: 'mercadolivre',
      title: data.title,
      price: data.price,
      originalPrice: data.originalPrice,
      pixPrice: data.pixPrice,
      discountPercent: data.discountPercent,
      image: data.image,
      currency: 'BRL',
      success: !!(data.title)
    }
  } catch (err: any) {
    return {
      marketplace: 'mercadolivre',
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
