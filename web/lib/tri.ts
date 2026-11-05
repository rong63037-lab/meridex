/** Pick zh / en / ms. Unknown languages use Chinese, which is the product default. */
export function tri(lang: string, zh: string, en: string, ms: string): string {
  if (lang === "en") return en;
  if (lang === "ms") return ms;
  return zh;
}
