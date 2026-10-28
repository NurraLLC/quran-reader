import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CreditStore } from '../../src/server/billing/credits';

it('reports manual funding and expenses with the same reserve and conversion as the hosted reader', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'quran-budget-'));
  const env = { ...process.env, QO_STATE_DIR: stateDir, QO_DONATIONS: '[500,1000,2500]', QO_SPONSOR_CENTS_PER_HOUR: '13', QO_OPERATING_RESERVE_CENTS: '600' };
  const run = (script: string, ...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', script, ...args], { env, encoding: 'utf8' });
  try {
    // An owner adds 100 hours, but $6 remains protected from listening.
    expect(run('scripts/sponsor-pool.ts', '100', 'test')).toContain('53.8 h available after the operating reserve');
    const report = JSON.parse(run('scripts/project-cost.ts', 'test-hosting', 'hosting', '1.25'));
    const store = new CreditStore(path.join(stateDir, 'credits.db'), {
      freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMinSeconds: 20, holdMaxSeconds: 1200,
      costCentsPerHour: 13, operatingReserveUsdMicros: 6_000_000,
    });
    try {
      const stats = store.poolStats();
      expect(report).toMatchObject({ ...stats, changed: true });
      expect(stats.left).toBe(360_000 - Math.ceil(600 * 3600 / 13) - Math.ceil(125 * 3600 / 13));
      expect(stats.given).toBe(stats.used + stats.costs + stats.operatingReserve + stats.left);
      // Re-importing the same receipt must not reduce the budget again.
      expect(JSON.parse(run('scripts/project-cost.ts', 'test-hosting', 'hosting', '1.25'))).toMatchObject({ ...stats, changed: false });
    } finally { store.close(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
