// npm run pool:add -- <hours> [note]
// Adds hours to the shared sponsored-listening pool of the hosted service (for gifts received outside
// Stripe, or the owner funding free listening). Uses QO_STATE_DIR like the server (default data/state).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { CreditStore } from '../src/server/billing/credits';
import { ROOT } from '../src/server/corpus/manifest';
import { parseDonations } from '../src/server/billing/stripe';

const hours = Number(process.argv[2]);
if (!Number.isFinite(hours) || hours <= 0 || hours > 100_000) {
  console.error('Usage: npm run pool:add -- <hours> [note]');
  process.exit(2);
}
const note = process.argv.slice(3).join(' ').slice(0, 80) || 'owner';
const store = new CreditStore(path.join(process.env.QO_STATE_DIR || path.join(ROOT, 'data', 'state'), 'credits.db'), {
  freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMinSeconds: 20, holdMaxSeconds: 1200,
  costCentsPerHour: parseDonations(process.env.QO_DONATIONS, process.env.QO_SPONSOR_CENTS_PER_HOUR).centsPerHour,
  operatingReserveUsdMicros: Number(process.env.QO_OPERATING_RESERVE_CENTS ?? 0) * 10_000,
});
store.grantPool(hours * 3600, `manual:${note}:${randomBytes(6).toString('hex')}`);
console.log(`Added ${hours} h. The sponsored pool now has ${(store.poolSeconds() / 3600).toFixed(1)} h available after the operating reserve.`);
store.close();
