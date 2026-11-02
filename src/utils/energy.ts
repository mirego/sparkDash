/**
 * Shared GPU-energy display helpers used by both the Overview "today" pill and
 * the energy modal (all-time boxes).
 */

/**
 * Electricity rate, CAD/kWh. User is on a COMMERCIAL building on Hydro-Québec
 * Rate G (Small Power, 2026 book): 12.388¢/kWh FIRST 15,090 kWh/mo, then
 * 9.534¢/kWh beyond. We deliberately use the MAX tier (12.388¢) so the
 * displayed cost is the worst case / ceiling. Fixed $15.426/mo access fee and
 * $22.071/kW demand charge (only above 50 kW) don't scale with Wh.
 */
export const PRICE_CAD_PER_KWH = 0.12388;

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
