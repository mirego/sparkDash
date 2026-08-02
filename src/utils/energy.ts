/**
 * Shared GPU-energy display helpers used by both the Overview "today" pill and
 * the energy modal (all-time boxes).
 */

/** Approximate blended retail price of electricity in Montreal, QC
 * (Hydro-Québec, Res. Rate D), CAD/kWh. Rough all-in figure — adjust freely.
 */
export const PRICE_CAD_PER_KWH = 0.10;

/** Format Wh → human short string (auto-scales to kWh). */
export function fmtEnergyWh(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(2)} kWh` : `${Math.round(v)} Wh`;
}

/** Format a Wh amount as an approximate CAD cost (3 decimals below $1). */
export function fmtCost(wh: number): string {
  const cost = (wh / 1000) * PRICE_CAD_PER_KWH;
  const digits = cost < 1 && cost > 0 ? 3 : 2;
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(cost);
}
