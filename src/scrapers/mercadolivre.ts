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
    const startTime = Date.now()
    const maskMlUrl = (u: string) => {
      try {
        const parsed = new URL(u)
        parsed.search = ''
        parsed.hash = ''
        let masked = parsed.toString()
        masked = masked.replace(/\/p\/[A-Z0-9]+/, '/p/***').replace(/\/MLB-?\d+/, '/MLB-***').replace(/\/up\/[A-Z0-9]+/, '/up/***')
        return masked
      } catch { return u }
    }

    const checkRedirect = (u: string, event: string) => {
      const lower = u.toLowerCase()
      if (lower.includes('/gz/account-verification') || lower.includes('/login') || lower.includes('/registration') || lower.includes('captcha') || lower.includes('challenge')) {
        console.info('[SCRAPER-ML-REDIRECT-DETECTED]', {
          reason: lower.includes('account-verification') ? 'account_verification' : 'other_challenge',
          atEvent: event,
          url: maskMlUrl(u),
          elapsedMs: Date.now() - startTime
        })
      }
    }

    console.info('[SCRAPER-ML-NAV]', { event: 'goto_start', url: maskMlUrl(cleanUrl), elapsedMs: 0 })

    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        const u = frame.url()
        console.info('[SCRAPER-ML-NAV]', { event: 'main_frame_navigated', url: maskMlUrl(u), elapsedMs: Date.now() - startTime })
        checkRedirect(u, 'main_frame_navigated')
      }
    })

    page.on('request', request => {
      if (request.isNavigationRequest() && request.resourceType() === 'document') {
        const u = request.url()
        console.info('[SCRAPER-ML-NAV]', { event: 'document_request', url: maskMlUrl(u), method: request.method(), elapsedMs: Date.now() - startTime })
        checkRedirect(u, 'document_request')
      }
    })

    page.on('response', response => {
      const req = response.request()
      if (req.isNavigationRequest() && req.resourceType() === 'document') {
        const u = response.url()
        console.info('[SCRAPER-ML-NAV]', { event: 'document_response', status: response.status(), url: maskMlUrl(u), elapsedMs: Date.now() - startTime })
        checkRedirect(u, 'document_response')
      }
    })

    const response = await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null)
    console.info('[SCRAPER-ML-NAV]', { event: 'goto_response', status: response ? response.status() : null, url: response ? maskMlUrl(response.url()) : null, elapsedMs: Date.now() - startTime })
    console.info('[SCRAPER-ML-NAV]', { event: 'after_goto', pageUrl: maskMlUrl(page.url()) })

    console.info('[SCRAPER-ML-NAV]', { event: 'before_wait_selector', pageUrl: maskMlUrl(page.url()) })
    // Aguarda preço renderizar (e aguarda redirecionamento se houver challenge)
    const waitSuccess = await page.waitForSelector(
      '.andes-money-amount__fraction, [class*="price-tag-fraction"]',
      { timeout: 20000 }
    ).then(() => true).catch(() => false)
    console.info('[SCRAPER-ML-NAV]', { event: 'after_wait_selector', pageUrl: maskMlUrl(page.url()), success: waitSuccess })

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

    if (!data.title || !data.price || !data.image) {
      try {
        const finalUrl = page.url()
        const maskedUrl = finalUrl.split('?')[0].replace(/\/p\/[A-Z0-9]+/, '/p/***').replace(/\/MLB-?\d+/, '/MLB-***').replace(/\/up\/[A-Z0-9]+/, '/up/***')
        const pageTitle = await page.title().catch(() => 'unknown')
        const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
        const bodyPreview = bodyText.replace(/\s+/g, ' ').substring(0, 800).trim()
        const bodyLower = bodyText.toLowerCase()

        console.info('[SCRAPER-ML-VISIBLE-DIAG]', {
          maskedUrl,
          pageTitle,
          bodyTextLength: bodyText.length,
          bodyPreview,
          hasComprarAgora: bodyLower.includes('comprar agora'),
          hasAdicionarCarrinho: bodyLower.includes('adicionar ao carrinho'),
          hasAccountVerification: finalUrl.includes('/gz/account-verification'),
          hasLoginText: bodyLower.includes('olá! para continuar') || bodyLower.includes('sou novo') || bodyLower.includes('já tenho conta'),
          hasCaptchaText: bodyLower.includes('captcha'),
          hasRobotText: bodyLower.includes('verifique que você não é um robô') || bodyLower.includes('robô'),
          hasCookieText: bodyLower.includes('cookie'),
          hasOpsText: bodyLower.includes('ops') || bodyLower.includes('não encontramos'),
          hasMercadoLivreText: bodyLower.includes('mercado livre')
        })
      } catch (diagErr) {
        console.error('[SCRAPER-ML-VISIBLE-DIAG] Failed:', diagErr)
      }
    }

    console.info('[SCRAPER-ML-NAV]', { event: 'before_return', pageUrl: maskMlUrl(page.url()) })
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
