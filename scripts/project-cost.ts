// Record project-only USD expenses, using a stable private receipt ID for safe retry/correction.
import path from 'node:path';
import { CreditStore } from '../src/server/billing/credits';
import { ROOT } from '../src/server/corpus/manifest';
import { parseDonations } from '../src/server/billing/stripe';

const [id, category, dollars] = process.argv.slice(2);
if (!id || !['hosting', 'payment_fees', 'ai', 'other'].includes(category) || !/^\d{1,6}(\.\d{1,6})?$/.test(dollars ?? '')) {
  console.error('Usage: npx tsx scripts/project-cost.ts <receipt-id> <hosting|payment_fees|ai|other> <USD amount>');
  process.exit(2);
}
const [whole, fraction = ''] = dollars.split('.');
const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
const store = new CreditStore(path.join(process.env.QO_STATE_DIR || path.join(ROOT, 'data', 'state'), 'credits.db'), {
  freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMinSeconds: 20, holdMaxSeconds: 1200,
  costCentsPerHour: parseDonations(process.env.QO_DONATIONS, process.env.QO_SPONSOR_CENTS_PER_HOUR).centsPerHour,
  operatingReserveUsdMicros: Number(process.env.QO_OPERATING_RESERVE_CENTS ?? 0) * 10_000,
});
try {
  const changed = store.recordCost(id, category as 'hosting' | 'payment_fees' | 'ai' | 'other', micros);
  console.log(JSON.stringify({ changed, ...store.poolStats() }));
} finally { store.close(); }
