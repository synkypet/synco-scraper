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
    await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null)

    // Aguardar algum sinal vital do ML
    await Promise.all([
      page.waitForSelector('.ui-pdp-title', { timeout: 3000 }).catch(() => null),
      page.waitForSelector('.andes-money-amount', { timeout: 3000 }).catch(() => null),
      page.waitForSelector('link[rel="preload"][as="image"]', { timeout: 3000 }).catch(() => null),
      page.waitForSelector('img[src*="mlstatic.com"]', { timeout: 3000 }).catch(() => null),
    ])

    const html = await page.content()
    const htmlLength = html.length
    
    // Diagnostic
    const hasMlstatic = html.includes('mlstatic.com')
    const hasPriceLiteral = html.includes('"price":') || html.includes('"current_price":')
    const hasOriginalPriceLiteral = html.includes('"original_price":')
    const hasItemId = html.includes('"item_id":')
    const hasCatalogProductId = html.includes('"catalog_product_id":')
    const hasPreloadImage = html.includes('rel="preload"') && html.includes('as="image"')
    const h1Count = html.match(/<h1/g)?.length || 0
    const moneyAmountCount = html.match(/andes-money-amount/g)?.length || 0
    const imageCount = html.match(/<img/g)?.length || 0
    const hasCaptcha = html.includes('captcha') || html.includes('sec-challenge') || html.includes('px-captcha')
    const hasLoginWall = html.includes('hub/login') || html.includes('Ingresa a tu cuenta')
    const hasCookieBanner = html.includes('cookie') || html.includes('consent')

    console.info('[SCRAPER-ML-DOM-DIAG]', {
      urlKind: 'unknown',
      finalUrlKind: 'unknown',
      htmlLength,
      hasMlstatic,
      hasPriceLiteral,
      hasOriginalPriceLiteral,
      hasItemId,
      hasCatalogProductId,
      hasPreloadImage,
      h1Count,
      moneyAmountCount,
      imageCount,
      hasCaptcha,
      hasLoginWall,
      hasCookieBanner
    })

    // Hydration parser
    let hydrationTitle: string | null = null
    let hydrationPrice: number | null = null
    let hydrationOriginalPrice: number | null = null
    let hydrationImage: string | null = null
    let hydrationItemId: string | null = null
    let hydrationCatalogId: string | null = null
    
    // Imagem via Preload
    const preloadSetMatch = html.match(/<link[^>]*rel=["']preload["'][^>]*as=["']image["'][^>]*imagesrcset=["']([^"']+)["']/i) ||
                            html.match(/<link[^>]*imagesrcset=["']([^"']+)["'][^>]*rel=["']preload["'][^>]*as=["']image["']/i);
    if (preloadSetMatch) {
      const srcset = preloadSetMatch[1]
      const urls = srcset.split(',').map(s => s.trim().split(' ')[0]).filter(u => u.includes('mlstatic.com'));
      if (urls.length > 0) {
        const fOrO = urls.find(u => u.includes('-F.') || u.includes('-O.'));
        const b = urls.find(u => u.includes('-B.'));
        const l = urls.find(u => u.includes('-L.'));
        hydrationImage = fOrO || b || l || urls[0];
      }
    } else {
      const preloadHrefMatch = html.match(/<link[^>]*rel=["']preload["'][^>]*as=["']image["'][^>]*href=["']([^"']+)["']/i);
      if (preloadHrefMatch) {
        hydrationImage = preloadHrefMatch[1];
        if (!hydrationImage.includes('mlstatic.com')) hydrationImage = null;
      }
    }

    // Hydration event_data
    const scriptsWithEventData = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of scriptsWithEventData) {
      const scriptText = match[1];
      if (scriptText.includes('"event_data"') || scriptText.includes('"main_actions"')) {
        const pMatch = scriptText.match(/"price"\s*:\s*([0-9.]+)/);
        const opMatch = scriptText.match(/"original_price"\s*:\s*([0-9.]+)/);
        const itemIdMatch = scriptText.match(/"item_id"\s*:\s*"((?:MLB|MLA|MLU|MLC|MLM|MLBU)[0-9]+)"/i);
        const catalogIdMatch = scriptText.match(/"catalog_product_id"\s*:\s*"((?:MLB|MLA|MLU|MLC|MLM|MLBU)[0-9]+)"/i);
        const titleMatch = scriptText.match(/"title"\s*:\s*"([^"]+)"/) || scriptText.match(/"name"\s*:\s*"([^"]+)"/);

        if (pMatch && !hydrationPrice) {
          const val = parseFloat(pMatch[1]);
          if (!isNaN(val) && val > 0) {
            hydrationPrice = val;
            if (opMatch) {
              const oVal = parseFloat(opMatch[1]);
              if (!isNaN(oVal) && oVal > 0) hydrationOriginalPrice = oVal;
            }
          }
        }
        if (itemIdMatch && !hydrationItemId) hydrationItemId = itemIdMatch[1].toUpperCase();
        if (catalogIdMatch && !hydrationCatalogId) hydrationCatalogId = catalogIdMatch[1].toUpperCase();
        if (titleMatch && !hydrationTitle) {
          const t = titleMatch[1].replace(/\\u002F/g, '/').replace(/\\u0022/g, '"').replace(/\\u0027/g, "'");
          hydrationTitle = t;
        }
      }
    }

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

    // Merge DOM and Hydration data
    const finalTitle = hydrationTitle || data.title;
    const finalPrice = hydrationPrice || data.price;
    const finalOriginalPrice = hydrationOriginalPrice || data.originalPrice;
    const finalImage = hydrationImage || data.image;

    if (!finalTitle || !finalImage || !finalPrice) {
      console.info('[SCRAPER-ML-SELECTORS-FAILED]', {
        reason: 'no_selectors_matched',
        attemptedTitleSelectors: ['h1.ui-pdp-title', 'meta[og:title]'],
        attemptedPriceSelectors: ['meta[itemprop="price"]', '[data-testid="price-part"]', '.ui-pdp-price__subtitles'],
        attemptedImageSelectors: ['meta[og:image]', '.ui-pdp-image'],
        hydrationSignals: { hasHydrationPrice: !!hydrationPrice, hasHydrationImage: !!hydrationImage, hasHydrationTitle: !!hydrationTitle }
      })
    }

    return {
      marketplace: 'mercadolivre',
      title: finalTitle,
      price: finalPrice,
      originalPrice: finalOriginalPrice,
      pixPrice: data.pixPrice,
      discountPercent: data.discountPercent,
      image: finalImage,
      currency: 'BRL',
      success: !!(finalTitle),
      // Extend result for SYNCO
      source: hydrationPrice || hydrationImage ? 'render_hydration' : 'render_dom',
      offerItemId: hydrationItemId,
      catalogProductId: hydrationCatalogId
    } as ScrapeResult & { source: string, offerItemId?: string | null, catalogProductId?: string | null }
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
