export type Marketplace = 'mercadolivre' | 'shopee' | 'magalu' | 'amazon' | 'generic'

export function detectMarketplace(url: string): Marketplace {
  const lower = url.toLowerCase()
  if (lower.includes('mercadolivre.com') || lower.includes('mercadolibre.com') || lower.includes('meli.com')) return 'mercadolivre'
  if (lower.includes('shopee.com')) return 'shopee'
  if (lower.includes('magazineluiza.com') || lower.includes('magalu.com')) return 'magalu'
  if (lower.includes('amazon.com.br')) return 'amazon'
  return 'generic'
}
