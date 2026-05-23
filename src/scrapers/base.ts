export interface ScrapeResult {
  marketplace: string
  title: string | null
  price: number | null          // currentPrice (preço padrão)
  originalPrice: number | null  // preço riscado
  pixPrice: number | null       // preço no Pix (informativo)
  discountPercent: number       // ex: 48
  image: string | null
  currency: string
  success: boolean
  error?: string
}
