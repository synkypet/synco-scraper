import { BrowserPool } from '../browser-pool'

export interface MLResolveResult {
  success: boolean
  sourceType: 'meli_short' | 'social_affiliate' | 'product_url' | 'unknown'
  productUrl: string | null
  itemId: string | null
  errorCode: string | null
}

export interface MLResolveSocialResponse extends MLResolveResult {
  rawProductUrl?: string | null
}

export async function resolveMLProductUrl(
  inputUrl: string,
  pool: BrowserPool
): Promise<MLResolveSocialResponse> {
  let sourceType: 'meli_short' | 'social_affiliate' | 'product_url' | 'unknown' = 'unknown'

  // STEP 1 — Classificar a URL de entrada
  if (inputUrl.includes('meli.la')) {
    sourceType = 'meli_short'
  } else if (inputUrl.includes('/social/')) {
    sourceType = 'social_affiliate'
  } else if (inputUrl.includes('mercadolivre.com.br') || inputUrl.includes('mercadolibre.com')) {
    sourceType = 'product_url'
    const productUrl = normalizeMLUrl(inputUrl)
    const itemId = extractMLItemId(productUrl)
    return { success: true, sourceType, productUrl, rawProductUrl: inputUrl, itemId, errorCode: null }
  } else {
    return { success: false, sourceType: 'unknown', productUrl: null, itemId: null, errorCode: 'invalid_url' }
  }

  // STEP 2 — Usar Playwright
  console.log('[RESOLVE-SOCIAL] sourceType:', sourceType)
  const context = await pool.acquire()
  
  try {
    const page = await context.newPage()

    let capturedProductUrl: string | null = null

    // Interceptar navegação para ver se cai direto em um produto
    page.on('response', response => {
      const url = response.url()
      if (!capturedProductUrl && isMLProductUrl(url)) {
        capturedProductUrl = url
      }
    })

    // Abrir a URL com timeout de 15s
    await page.goto(inputUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })

    // Tentar 1: verificar se a própria URL final é um produto (após redirecionamentos)
    const currentUrl = page.url()
    if (!capturedProductUrl && isMLProductUrl(currentUrl)) {
      capturedProductUrl = currentUrl
    }

    // Tentar 2: procurar link "Ir para produto" (ou similares) no DOM
    if (!capturedProductUrl) {
      const ctaUrl = await page.evaluate(() => {
        const ctaTexts = ['ir para produto', 'ver produto', 'acessar produto']
        
        // 1. Tentar encontrar <a> com o texto
        const links = Array.from(document.querySelectorAll('a'))
        for (const link of links) {
          const text = (link.textContent || '').trim().toLowerCase()
          if (ctaTexts.some(t => text.includes(t)) && link.href) {
            return { type: 'href', url: link.href }
          }
        }
        
        // 2. Tentar encontrar botões com o texto (que disparam navegação)
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'))
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase()
          if (ctaTexts.some(t => text.includes(t))) {
            return { type: 'button', element: btn } // Só sinaliza que achou
          }
        }
        
        return null
      })

      if (ctaUrl) {
        if (ctaUrl.type === 'href' && ctaUrl.url) {
          capturedProductUrl = ctaUrl.url
        } else if (ctaUrl.type === 'button') {
          // Se for botão, precisamos clicar e esperar a navegação
          try {
            await Promise.all([
              page.waitForNavigation({ timeout: 5000 }).catch(() => null),
              page.evaluate(() => {
                const ctaTexts = ['ir para produto', 'ver produto', 'acessar produto']
                const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'))
                const btn = buttons.find(b => ctaTexts.some(t => (b.textContent || '').toLowerCase().includes(t)))
                if (btn) (btn as HTMLElement).click()
              })
            ])
            const newUrl = page.url()
            if (isMLProductUrl(newUrl)) {
              capturedProductUrl = newUrl
            }
          } catch (e) {
            // timeout no clique
          }
        }
      }
    }

    // Tentar 3: procurar no JSON embutido no __PRELOADED_STATE__
    if (!capturedProductUrl) {
      const stateUrl = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script'))
        for (const script of scripts) {
          const content = script.textContent || ''
          const match = content.match(
            /(https:\/\/(?:www\.)?mercadolivre\.com\.br\/[^"'\s]+\/(?:up\/MLBU|p\/MLB)[^"'\s]*)/
          )
          if (match) return match[1]
        }
        return null
      })
      if (stateUrl) capturedProductUrl = stateUrl
    }

    // Tentar 4 (fallback extremo sugerido): primeiro link com MLB (logando como frágil)
    if (!capturedProductUrl) {
      console.log('[RESOLVE-SOCIAL] Fallback frágil ativado: buscando primeiro link MLB no DOM')
      const firstMlbUrl = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]'))
        for (const link of links) {
          const href = (link as HTMLAnchorElement).href
          if (href.includes('/up/') || href.includes('/p/') || /MLB[A-Z0-9]+/.test(href)) {
            return href
          }
        }
        return null
      })
      if (firstMlbUrl) capturedProductUrl = firstMlbUrl
    }

    await page.close()

    if (!capturedProductUrl) {
      console.log('[RESOLVE-SOCIAL] product_url_found: false')
      return { success: false, sourceType, productUrl: null, itemId: null, errorCode: 'product_url_not_found' }
    }

    console.log('[RESOLVE-SOCIAL] product_url_found: true')
    const productUrlNormalized = normalizeMLUrl(capturedProductUrl)
    const itemId = extractMLItemId(productUrlNormalized)
    
    console.log('[RESOLVE-SOCIAL] success: true itemId:', itemId || 'null')

    return {
      success: true,
      sourceType,
      rawProductUrl: capturedProductUrl,
      productUrl: productUrlNormalized,
      itemId,
      errorCode: null
    }

  } catch (err: any) {
    console.log('[RESOLVE-SOCIAL] error:', err.message)
    return { success: false, sourceType, productUrl: null, itemId: null, errorCode: 'timeout' }
  } finally {
    pool.release(context)
  }
}

// === HELPER FUNCTIONS ===

function isMLProductUrl(url: string): boolean {
  return (url.includes('mercadolivre.com.br') || url.includes('mercadolibre.com')) &&
         !url.includes('/social/') &&
         (url.includes('/up/') || url.includes('/p/') || /MLB[A-Z0-9]+/.test(url))
}

function extractMLItemId(url: string): string | null {
  const matchMLBU = url.match(/\/up\/(MLBU[A-Z0-9]+)/i)
  if (matchMLBU) return matchMLBU[1]
  const matchMLB = url.match(/(MLB\d+)/i)
  if (matchMLB) return matchMLB[1]
  return null
}

function normalizeMLUrl(url: string): string {
  try {
    const u = new URL(url)
    
    // Remover tracking antigo/indesejado
    u.searchParams.delete('matt_word')
    u.searchParams.delete('matt_tool')
    u.searchParams.delete('matt_event_ts')
    u.searchParams.delete('matt_d2id')
    u.searchParams.delete('matt_tracing_id')
    u.searchParams.delete('forceInApp')
    u.searchParams.delete('ref')

    return u.toString()
  } catch {
    return url
  }
}
