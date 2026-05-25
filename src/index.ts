import express from 'express'
import { BrowserPool } from './browser-pool'
import { scrape } from './scraper'
import { cache } from './cache'
import { resolveMLProductUrl } from './scrapers/ml-resolve-social'

const app = express()
app.use(express.json())

const POOL_SIZE = parseInt(process.env.POOL_SIZE || '2', 10)
const API_KEY = process.env.SCRAPER_API_KEY || ''
const pool = new BrowserPool(POOL_SIZE)

// Auth middleware
function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!API_KEY) return next() // sem chave configurada = sem auth (dev)
  const key = req.headers['x-api-key']
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' })
  next()
}

// Inicializa pool
pool.initialize().then(() => {
  console.log(`[POOL] ${POOL_SIZE} browsers prontos`)
  console.log(`[SCRAPER-ML] version=ml-direct-offer-timeout-20000-bypass`)
}).catch(err => {
  console.error('[POOL] Falha ao inicializar:', err)
  process.exit(1)
})

// Heartbeat — para cron externo pingar e manter o Render Free acordado
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() })
})

// Endpoint principal
app.post('/scrape', auth, async (req, res) => {
  const { url } = req.body

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' })
  }

  // Cache hit
  const cached = cache.get(url)
  if (cached) {
    return res.json({ ...cached, cached: true })
  }

  try {
    const result = await scrape(url, pool)
    if (result.success) cache.set(url, result)
    return res.json(result)
  } catch (err: any) {
    console.error('[SCRAPE ERROR]', err.message)
    return res.status(500).json({ error: 'scrape_failed', message: err.message })
  }
})

// Endpoint para resolução de links curtos/social do ML
app.post('/scrape/resolve-social', auth, async (req, res) => {
  const { url } = req.body

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'url is required', errorCode: 'invalid_url', sourceType: 'unknown' })
  }

  try {
    const result = await resolveMLProductUrl(url, pool)
    return res.json(result)
  } catch (err: any) {
    console.error('[RESOLVE-SOCIAL ERROR]', err.message)
    return res.status(500).json({ 
      success: false, 
      sourceType: 'unknown', 
      errorCode: 'scraper_error', 
      message: err.message 
    })
  }
})

// Graceful shutdown
process.on('SIGTERM', async () => {
  await pool.shutdown()
  process.exit(0)
})

const PORT = parseInt(process.env.PORT || '3001', 10)
app.listen(PORT, () => console.log(`[SERVER] Running on :${PORT}`))
