import { BrowserPool } from './browser-pool'
import { detectMarketplace } from './marketplace-detector'
import { scrapeMercadoLivre } from './scrapers/mercadolivre'
import { scrapeGeneric } from './scrapers/generic'
import { ScrapeResult } from './scrapers/base'

export async function scrape(url: string, pool: BrowserPool): Promise<ScrapeResult> {
  const marketplace = detectMarketplace(url)
  const ctx = await pool.acquire()

  try {
    switch (marketplace) {
      case 'mercadolivre':
        return await scrapeMercadoLivre(url, ctx)
      default:
        return await scrapeGeneric(url, ctx)
    }
  } finally {
    pool.release(ctx)
  }
}
