/** Display estimate only. Actual Stripe balance-transaction fees own ledger accounting.
 * Standard US domestic cards: https://stripe.com/pricing (2.9% + 30 cents).
 * Future provider invoices and other payment methods can change the final capacity.
 */
export function estimateSupportHours(amountCents: number, centsPerHour = 13, availableSeconds = 0): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0 || !Number.isFinite(centsPerHour) || centsPerHour < 1 || !Number.isFinite(availableSeconds)) throw new Error('Invalid support estimate');
  const feeCents = Math.min(amountCents, Math.ceil(amountCents * 290 / 10_000) + 30);
  // Mirror the ledger's conservative funding/expense rounding and cover existing deficits.
  const fundedSeconds = Math.floor(amountCents * 3600 / centsPerHour);
  const feeSeconds = Math.ceil(feeCents * 3600 / centsPerHour);
  return Math.round(Math.max(0, fundedSeconds - feeSeconds - Math.max(0, -availableSeconds)) / 3600);
}
