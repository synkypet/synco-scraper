export interface ScrapeResult {
  marketplace: string
  title: string | null
  price: number | null
  image: string | null
  currency: string
  success: boolean
  error?: string
}
