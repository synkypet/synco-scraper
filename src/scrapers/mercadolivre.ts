import { BrowserContext, Page } from 'playwright'
import { ScrapeResult } from './base'

export async function scrapeMercadoLivre(url: string, ctx: BrowserContext): Promise<ScrapeResult> {
  const cleanUrl = (() => {
    try {
      const u = new URL(url)
      u.search = ''
      u.hash = ''
      return u.toString()
    } catch { return url }
  })()

  let page = await ctx.newPage()
  let accessBlocked = false
  let blockedReason = ''

  try {
    const maxAttempts = 2
    const maxMs = 30000
    const intervalMs = 1000

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[SCRAPER-ML-SMART-POLL] start attempt=${attempt} maxMs=${maxMs} intervalMs=${intervalMs}`)
      
      // Attempt 1 uses cleanUrl. If blocked, attempt 2 uses the original full URL and clears cookies.
      const targetUrl = attempt === 1 ? cleanUrl : url
      
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null)

      let elapsedMs = 0
      let successData: any = null
      let lastLogMs = 0

      while (elapsedMs < maxMs) {
        // Fast abort on verification block
        const currentUrl = page.url()
        if (currentUrl.includes('/gz/account-verification')) {
          const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
          if (bodyText.toLowerCase().includes('olá! para continuar, acesse sua conta') || bodyText.toLowerCase().includes('verifique que você não é um robô')) {
            console.log(`[SCRAPER-ML-ACCESS-BLOCKED] reason=account_verification attempt=${attempt}`)
            accessBlocked = true
            blockedReason = 'account_verification'
            break
          }
        }
        accessBlocked = false
        // Handle cookie banner
        const cookieHandled = await page.evaluate(() => {
          const cookieTexts = ['aceitar cookies', 'aceptar cookies', 'aceitar', 'aceptar', 'entendi', 'continuar']
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'))
          const btn = buttons.find(b => cookieTexts.some(t => (b.textContent || '').toLowerCase().trim() === t))
          if (btn) {
            (btn as HTMLElement).click()
            return true
          }
          return false
        }).catch(() => false)
        
        if (cookieHandled) {
          console.log(`[SCRAPER-ML-COOKIE] detected=true clicked=true attempt=${attempt}`)
        }

        const html = await page.content().catch(() => '')
        const hydration = extractHydration(html)
        const dom = await extractDom(page).catch(() => ({} as any))

        const title = hydration.title || dom.title
        const price = hydration.price || dom.price
        const image = hydration.image || dom.image

        const hasTitle = !!title
        const hasPrice = !!price
        const hasImage = !!image

        if (elapsedMs - lastLogMs >= 5000 || (hasTitle && hasPrice && hasImage)) {
          console.log(`[SCRAPER-ML-SMART-POLL] tick attempt=${attempt} elapsedMs=${elapsedMs} title=${hasTitle} price=${hasPrice} image=${hasImage} itemId=${!!hydration.itemId}`)
          lastLogMs = elapsedMs
        }

        if (hasTitle && hasPrice && hasImage) {
          console.log(`[SCRAPER-ML-SMART-POLL] success attempt=${attempt} elapsedMs=${elapsedMs} title=true price=true image=true`)
          successData = { hydration, dom, html }
          break
        }

        await page.waitForTimeout(intervalMs)
        elapsedMs += intervalMs
      }

      if (successData) {
        const { hydration, dom, html } = successData
        
        // Diagnostic
        const htmlLength = html.length
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

        const finalTitle = hydration.title || dom.title
        const finalPrice = hydration.price || dom.price
        const finalOriginalPrice = hydration.originalPrice || dom.originalPrice
        const finalImage = hydration.image || dom.image

        return {
          marketplace: 'mercadolivre',
          title: finalTitle,
          price: finalPrice,
          originalPrice: finalOriginalPrice,
          pixPrice: dom.pixPrice,
          discountPercent: dom.discountPercent,
          image: finalImage,
          currency: 'BRL',
          success: !!finalTitle,
          source: hydration.price || hydration.image ? 'render_hydration' : 'render_smart_poll',
          offerItemId: hydration.itemId,
          catalogProductId: hydration.catalogId
        } as ScrapeResult & { source: string, offerItemId?: string | null, catalogProductId?: string | null }
      }

      if (accessBlocked) {
        if (attempt < maxAttempts) {
          console.log(`[SCRAPER-ML-SMART-POLL] closing blocked page and clearing cookies for retry attempt=${attempt + 1}`)
          await page.close().catch(() => null)
          await ctx.clearCookies().catch(() => null)
          page = await ctx.newPage()
          continue
        } else {
          console.log(`[SCRAPER-ML-SMART-POLL] failed after ${maxAttempts} attempts due to access block`)
          break
        }
      }

      if (attempt < maxAttempts) {
        console.log(`[SCRAPER-ML-SMART-POLL] reload attempt=${attempt + 1} reason=timeout_no_core_metadata`)
        await page.close().catch(() => null)
        await ctx.clearCookies().catch(() => null)
        page = await ctx.newPage()
      } else {
        console.log(`[SCRAPER-ML-SMART-POLL] failed attempts=${maxAttempts} totalMs=${maxAttempts * maxMs} reason=no_product_signals`)
        
        try {
          const finalUrl = page.url()
          const maskedUrl = finalUrl.split('?')[0].replace(/\/p\/[A-Z0-9]+/, '/p/***').replace(/\/MLB-?\d+/, '/MLB-***')
          const pageTitle = await page.title().catch(() => 'unknown')
          const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
          const bodyPreview = bodyText.substring(0, 800).replace(/\n+/g, ' ').trim()
          const bodyLower = bodyText.toLowerCase()
          
          console.info('[SCRAPER-ML-VISIBLE-DIAG]', {
            maskedUrl,
            pageTitle,
            bodyTextLength: bodyText.length,
            bodyPreview,
            hasComprarAgora: bodyLower.includes('comprar agora'),
            hasAdicionarCarrinho: bodyLower.includes('adicionar ao carrinho'),
            hasRobotText: bodyLower.includes('robô') || bodyLower.includes('robot'),
            hasCaptchaText: bodyLower.includes('captcha') || bodyLower.includes('verifique'),
            hasCookieText: bodyLower.includes('cookies'),
            hasLoginText: bodyLower.includes('entre na sua conta') || bodyLower.includes('ingresa a tu cuenta'),
            hasOpsText: bodyLower.includes('ops') || bodyLower.includes('não encontramos')
          })

          if (process.env.DEBUG_SCRAPER_SCREENSHOT === 'true') {
            await page.screenshot({ path: `/tmp/ml_fail_${Date.now()}.png` }).catch(() => null)
          }
        } catch (diagErr) {
          console.error('[SCRAPER-ML-VISIBLE-DIAG] Failed to capture diag:', diagErr)
        }

        console.info('[SCRAPER-ML-SELECTORS-FAILED]', {
          reason: 'no_selectors_matched',
          attemptedTitleSelectors: ['h1.ui-pdp-title', 'meta[og:title]'],
          attemptedPriceSelectors: ['meta[itemprop="price"]', '[data-testid="price-part"]', '.ui-pdp-price__subtitles'],
          attemptedImageSelectors: ['meta[og:image]', '.ui-pdp-image'],
          hydrationSignals: { hasHydrationPrice: false, hasHydrationImage: false, hasHydrationTitle: false }
        })
      }
    }

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
      error: accessBlocked ? blockedReason : 'no_selectors_matched',
      accessBlocked
    } as any

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

function extractHydration(html: string) {
  let hydrationTitle: string | null = null
  let hydrationPrice: number | null = null
  let hydrationOriginalPrice: number | null = null
  let hydrationImage: string | null = null
  let hydrationItemId: string | null = null
  let hydrationCatalogId: string | null = null
  
  const preloadSetMatch = html.match(/<link[^>]*rel=["']preload["'][^>]*as=["']image["'][^>]*imagesrcset=["']([^"']+)["']/i) ||
                          html.match(/<link[^>]*imagesrcset=["']([^"']+)["'][^>]*rel=["']preload["'][^>]*as=["']image["']/i)
  if (preloadSetMatch) {
    const srcset = preloadSetMatch[1]
    const urls = srcset.split(',').map(s => s.trim().split(' ')[0]).filter(u => u.includes('mlstatic.com'))
    if (urls.length > 0) {
      const fOrO = urls.find(u => u.includes('-F.') || u.includes('-O.'))
      const b = urls.find(u => u.includes('-B.'))
      const l = urls.find(u => u.includes('-L.'))
      hydrationImage = fOrO || b || l || urls[0]
    }
  } else {
    const preloadHrefMatch = html.match(/<link[^>]*rel=["']preload["'][^>]*as=["']image["'][^>]*href=["']([^"']+)["']/i)
    if (preloadHrefMatch) {
      hydrationImage = preloadHrefMatch[1]
      if (!hydrationImage.includes('mlstatic.com')) hydrationImage = null
    }
  }

  const scriptsWithEventData = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)
  for (const match of scriptsWithEventData) {
    const scriptText = match[1]
    if (scriptText.includes('"event_data"') || scriptText.includes('"main_actions"')) {
      const pMatch = scriptText.match(/"price"\s*:\s*([0-9.]+)/)
      const opMatch = scriptText.match(/"original_price"\s*:\s*([0-9.]+)/)
      const itemIdMatch = scriptText.match(/"item_id"\s*:\s*"((?:MLB|MLA|MLU|MLC|MLM|MLBU)[0-9]+)"/i)
      const catalogIdMatch = scriptText.match(/"catalog_product_id"\s*:\s*"((?:MLB|MLA|MLU|MLC|MLM|MLBU)[0-9]+)"/i)
      const titleMatch = scriptText.match(/"title"\s*:\s*"([^"]+)"/) || scriptText.match(/"name"\s*:\s*"([^"]+)"/)

      if (pMatch && !hydrationPrice) {
        const val = parseFloat(pMatch[1])
        if (!isNaN(val) && val > 0) {
          hydrationPrice = val
          if (opMatch) {
            const oVal = parseFloat(opMatch[1])
            if (!isNaN(oVal) && oVal > 0) hydrationOriginalPrice = oVal
          }
        }
      }
      if (itemIdMatch && !hydrationItemId) hydrationItemId = itemIdMatch[1].toUpperCase()
      if (catalogIdMatch && !hydrationCatalogId) hydrationCatalogId = catalogIdMatch[1].toUpperCase()
      if (titleMatch && !hydrationTitle) {
        hydrationTitle = titleMatch[1].replace(/\\u002F/g, '/').replace(/\\u0022/g, '"').replace(/\\u0027/g, "'")
      }
    }
  }

  return { title: hydrationTitle, price: hydrationPrice, originalPrice: hydrationOriginalPrice, image: hydrationImage, itemId: hydrationItemId, catalogId: hydrationCatalogId }
}

async function extractDom(page: Page) {
  return await page.evaluate(() => {
    const title = document.querySelector('h1.ui-pdp-title')?.textContent?.trim() || document.querySelector('meta[property="og:title"]')?.getAttribute('content') || null
    const originalEl = document.querySelector('s.ui-pdp-price__original-value')
    const originalFraction = originalEl?.querySelector('.andes-money-amount__fraction')?.textContent?.replace(/\./g, '') || ''
    const originalCents = originalEl?.querySelector('.andes-money-amount__cents')?.textContent?.trim() || '00'
    const originalPrice = originalFraction ? parseFloat(`${originalFraction}.${originalCents}`) : null
    let mainPrice: number | null = null
    const metaPrice = document.querySelector('meta[itemprop="price"]')?.getAttribute('content')
    if (metaPrice) mainPrice = parseFloat(metaPrice)
    if (!mainPrice) {
      const pricePartEl = document.querySelector('[data-testid="price-part"]') || document.querySelector('.ui-pdp-price__part__container')
      if (pricePartEl) {
        const fraction = pricePartEl.querySelector('.andes-money-amount__fraction')?.textContent?.replace(/\./g, '') || ''
        const cents = pricePartEl.querySelector('.andes-money-amount__cents')?.textContent?.trim() || '00'
        if (fraction) mainPrice = parseFloat(`${fraction}.${cents}`)
      }
    }
    if (!mainPrice) {
      const subtitleText = document.querySelector('.ui-pdp-price__subtitles')?.textContent || ''
      const subtitleMatch = subtitleText.match(/ou R\$\s*([\d.]+(?:,\d{2})?)/) || subtitleText.match(/R\$\s*([\d.]+(?:,\d{2})?)/)
      const standardPriceRaw = subtitleMatch?.[1]?.replace(/\./g, '').replace(',', '.') || null
      if (standardPriceRaw) mainPrice = parseFloat(standardPriceRaw)
    }
    const pixEl = document.querySelector('.ui-pdp-price__second-line .andes-money-amount--weight-semibold')
    const pixFraction = pixEl?.querySelector('.andes-money-amount__fraction')?.textContent?.replace(/\./g, '') || ''
    const pixCents = pixEl?.querySelector('.andes-money-amount__cents')?.textContent?.trim() || '00'
    const pixPrice = pixFraction ? parseFloat(`${pixFraction}.${pixCents}`) : null
    const discountText = document.querySelector('.andes-money-amount__discount')?.textContent || ''
    const discountMatch = discountText.match(/(\d+)%/)
    const discountPercent = discountMatch ? parseInt(discountMatch[1]) : 0
    const price = mainPrice ?? pixPrice ?? originalPrice
    const image = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || document.querySelector('.ui-pdp-image')?.getAttribute('src') || null
    return { title, price, originalPrice, pixPrice, discountPercent, image }
  })
}
