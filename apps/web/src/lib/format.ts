/**
 * UI-2 (DEC-103): display only. Inserts thousands separators into a decimal the API returned ("11070.00" -> "11,070.00"); no arithmetic and
 * no rounding, so the screen still shows exactly the API's figure (DEC-048, DEC-071). Anything that is not a plain decimal is returned as it came.
 */
export function showAmount<T>(v: T): T | string {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^-?\d+(\.\d+)?$/.test(s)) return v;
  const [whole, frac] = s.replace('-', '').split('.');
  return `${s.startsWith('-') ? '-' : ''}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac !== undefined ? `.${frac}` : ''}`;
}
