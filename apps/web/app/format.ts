/** Bolívares con separador de miles «.» y decimales «,». Sin depender del locale del runtime. */
export function formatBolivares(value: number): string {
  const sign = value < 0 ? '-' : '';
  const [whole, frac] = Math.abs(value).toFixed(2).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${grouped},${frac}`;
}
