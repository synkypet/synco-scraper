import express from 'express'
import { BrowserPool } from './browser-pool'
import { scrape } from './scraper'
import { cache } from './cache'
import { resolveMLProductUrl } from './scrapers/ml-resolve-social'
import { enqueueMLJob, hashKey } from './queue'

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
  console.log(`[SCRAPER-ML] version=ml-queue-dedupe-v1`)
}).catch(err => {
  console.error('[POOL] Falha ao inicializar:', err)
  process.exit(1)
})

// Endpoint rápido de healthcheck (antes de qualquer processamento pesado)
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: "synco-scraper",
    version: "ml-queue-dedupe-v1"
  })
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
    const keyHash = hashKey(url);
    console.log(`[SCRAPER-ML-CACHE] hit keyHash=${keyHash}`);
    return res.json({ ...cached, cached: true })
  }

  try {
    const isML = url.includes('mercadolivre') || url.includes('meli.la') || url.includes('mercadolibre');

    if (isML) {
      const keyHash = hashKey(url);
      console.log(`[SCRAPER-ML-CACHE] miss keyHash=${keyHash}`);
      
      const result = await enqueueMLJob(url, async () => {
        return await scrape(url, pool);
      });
      
      if (result.success || (result as any).title) {
        cache.set(url, result, 10 * 60 * 1000); // 10 minutes cache
      }
      return res.json(result);
    } else {
      const result = await scrape(url, pool)
      if (result.success) cache.set(url, result)
      return res.json(result)
    }
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

  const cached = cache.get(url)
  if (cached) {
    const keyHash = hashKey(url);
    console.log(`[SCRAPER-ML-CACHE] hit keyHash=${keyHash}`);
    return res.json({ ...cached, cached: true })
  }

  try {
    const keyHash = hashKey(url);
    console.log(`[SCRAPER-ML-CACHE] miss keyHash=${keyHash}`);
    
    const result = await enqueueMLJob(url, async () => {
      return await resolveMLProductUrl(url, pool);
    });

    if (result.success && result.productUrl) {
      cache.set(url, result, 10 * 60 * 1000); // 10 minutes cache
    }

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

const PORT = Number(process.env.PORT || 3001)
const HOST = process.env.HOST || '0.0.0.0'

app.listen(PORT, HOST, () => {
  console.log(`[SERVER] Running on ${HOST}:${PORT}`)
})
