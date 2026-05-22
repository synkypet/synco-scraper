# synco-scraper

Serviço de scraping de metadados de produtos para o Synco.
Roda no Render Free com Playwright + pool de browsers.

## Endpoints

GET /ping — healthcheck (para manter Render Free acordado)
POST /scrape — scraping de produto
  Body: { "url": "https://..." }
  Header: x-api-key: sua-chave
  Response: { title, price, image, marketplace, currency, success }

## Deploy

1. Push para GitHub
2. Render → New Web Service → Docker
3. Env vars: SCRAPER_API_KEY, PORT=3001

## Heartbeat

Configure cron-job.org ou UptimeRobot para pingar /ping a cada 10 minutos.
