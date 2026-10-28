// Lifetime community funding: total given, time used and time left. No monthly target,
// donor names, personal purchases or leaderboard. Optional donations add to everyone's time.
import { useEffect, useId, useState } from 'react';
import type { Donation, PoolStats } from './net';
import { formatListening, u } from './net';
import { estimateSupportHours } from '../shared/support-budget';

/** Opens Stripe's page for a gift; returns an error to show if it could not. */
export async function openDonation(amountCents: number): Promise<string | null> {
  const r = await fetch(u('/api/billing/donate'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amountCents }) }).catch(() => null);
  const body = (await r?.json().catch(() => ({}))) as { url?: string; error?: string };
  if (body?.url) {
    location.href = body.url;
    return null;
  }
  return body?.error ?? 'The payment page could not be opened. Please try again.';
}

/** "$10.00" reads as "$10". */
const price = (p: string) => p.replace(/\.00$/, '');
const duration = (seconds: number) => seconds === 0 ? '0 h' : `${seconds < 0 ? '−' : ''}${formatListening(Math.abs(seconds))}`;
const shortDuration = (seconds: number) => duration(seconds).replace(/ h/g, 'h').replace(/ min/g, 'm');

/** A balance composition, never a made-up usage history. Unfunded reserves don't fill the ring. */
function PoolGraph({ stats }: { stats: PoolStats }) {
  const pattern = `pool-reserve-${useId().replace(/:/g, '')}`;
  const funded = Math.max(0, stats.given);
  const spent = Math.max(0, stats.used + (stats.costs ?? 0));
  const reserve = Math.max(0, stats.operatingReserve ?? 0);
  const parts = [
    { kind: 'available', seconds: Math.max(0, Math.min(stats.left, funded)) },
    { kind: 'reserve', seconds: Math.min(reserve, Math.max(0, funded - spent)) },
    { kind: 'spent', seconds: Math.min(spent, funded) },
  ];
  const minutes = Math.floor(Math.abs(stats.left) / 60);
  const hours = Math.floor(minutes / 60);
  const value = hours > 0 ? `${hours}h` : minutes > 0 ? `${minutes}m` : stats.left !== 0 ? '<1m' : '0h';
  let offset = 0;
  return (
    <div className="r-pool-graph" role="img" aria-label={`${duration(stats.left)} ${stats.left < 0 ? 'funding shortfall' : 'available for listening'}. ${duration(stats.given)} funded; ${duration(reserve)} operating reserve${stats.left < 0 ? ' target' : ''}; ${duration(spent)} used for listening and recorded costs.`}>
      <svg viewBox="0 0 160 160" aria-hidden="true">
        <defs>
          <pattern id={pattern} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="var(--pool-reserve-soft)" />
            <path d="M 0 0 V 5" stroke="var(--pool-reserve)" strokeWidth="2" />
          </pattern>
        </defs>
        <circle className="r-pool-ring-base" cx="80" cy="80" r="66" />
        {parts.map(({ kind, seconds }) => {
          const percent = funded > 0 ? seconds / funded * 100 : 0;
          const start = offset;
          offset += percent;
          return percent > 0 ? <circle key={kind} className={`r-pool-ring ${kind}`} cx="80" cy="80" r="66" pathLength="100" strokeDasharray={`${Math.max(0, percent - Math.min(0.8, percent / 8))} 100`} strokeDashoffset={-start} style={kind === 'reserve' ? { stroke: `url(#${pattern})` } : undefined} /> : null;
        })}
      </svg>
      <div className="r-pool-graph-value" aria-hidden="true">
        <strong>{value}</strong>
        <span>{hours > 0 && minutes % 60 > 0 ? `${minutes % 60}m · ` : ''}{stats.left < 0 ? 'needed' : 'available'}</span>
      </div>
    </div>
  );
}

/** Live pool numbers: the initial ones, refreshed every minute while the page is visible. */
function useLivePool(initial: PoolStats | undefined): PoolStats | undefined {
  const [stats, setStats] = useState(initial);
  useEffect(() => setStats(initial), [initial]);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      fetch(u('/api/pool'), { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((s: PoolStats | null) => s && setStats(s))
        .catch(() => undefined);
    };
    const t = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, []);
  return stats;
}

export function SharedHours({ stats: initial, donations, testMode = false, defaultOpen = false }: { stats: PoolStats | undefined; donations: Donation[]; testMode?: boolean; defaultOpen?: boolean }) {
  const stats = useLivePool(initial);
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const bodyId = useId();
  if (!stats) return null;
  const give = async (c: number) => {
    setBusy(c);
    setNote(null);
    const err = await openDonation(c);
    if (err) {
      setBusy(null);
      setNote(err);
    }
  };
  return (
    <section className={`r-pool${open ? ' open' : ''}`} aria-label="Sponsored recitation hours">
      <div className="r-pool-overview">
        <PoolGraph stats={stats} />
        <div className="r-pool-summary">
          <p className="r-pool-title">Community powered</p>
          <p className="r-pool-funded"><strong>{shortDuration(stats.given)}</strong> funded</p>
          <dl className="r-pool-key">
            {!!stats.operatingReserve && <div className="reserve"><dt>{stats.left < 0 ? 'Reserve target' : 'Reserved'}</dt><dd>{shortDuration(stats.operatingReserve)}</dd></div>}
            <div className="spent"><dt>Used</dt><dd>{shortDuration(stats.used + (stats.costs ?? 0))}</dd></div>
          </dl>
          <button className="r-pool-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
            {open ? 'Close details' : 'Support reader'}<span aria-hidden="true">{open ? '−' : '+'}</span>
          </button>
        </div>
      </div>
        <div className="r-pool-body" id={bodyId} hidden={!open}>
          <h3>Keep recitation free.</h3>
          {donations.length > 0 && (
            <>
            {testMode && <p className="r-support-status" role="status">Test checkout — no real money. Use Stripe test details only.</p>}
            <div className="r-give-amounts">
              {donations.map((d) => {
                const hours = estimateSupportHours(d.amountCents, stats.centsPerHour ?? 13, stats.left);
                return (
                <button key={d.amountCents} disabled={busy !== null} onClick={() => void give(d.amountCents)}>
                  <strong>{busy === d.amountCents ? 'Opening…' : price(d.price)}</strong>
                  <span>{hours > 0 ? `≈ ${hours}h added` : 'Covers costs'}</span>
                </button>
                );
              })}
            </div>
            <p className="r-pool-estimate">After estimated card fees + current costs.</p>
            <p className="r-pool-checkout">One-time support · Secure checkout with Stripe</p>
            </>
          )}
          {!donations.length && <p className="r-support-status" role="status">Contributions are opening soon. Reading and sharing are always free.</p>}
          {note && <p className="r-note" role="alert">{note}</p>}
          <details className="r-pool-accounting">
            <summary>How hours are estimated</summary>
            <p>Shared hours = funding − listening − recorded costs − operating reserve. These are budget estimates, not a live cash balance.</p>
            <dl>
              <div><dt>Listening used</dt><dd>{duration(stats.used)}</dd></div>
              <div><dt>Recorded costs</dt><dd>{duration(stats.costs ?? 0)}</dd></div>
              {!!stats.operatingReserve && <div><dt>Operating reserve</dt><dd>${((stats.operatingReserveUsdMicros ?? 0) / 1_000_000).toFixed(2)} · not spent</dd></div>}
            </dl>
            <p>Contribution estimates use domestic card fees of 2.9% + 30¢ and cover any current funding shortfall first. Other payment methods can differ. Actual Stripe fees are recorded after payment.</p>
            <p>Future hosting and AI bills may reduce these hours. Listening uses a ${( (stats.centsPerHour ?? 13) / 100).toFixed(2)} hourly conversion while recognition is connected, including short pauses. Hosting continues between sessions. Totals refresh every minute.</p>
          </details>
          <p className="r-pool-legal">Support for Quran Reader, operated by Nurra LLC. Not a tax-deductible charitable donation.</p>
          <a className="r-give-more" href={u('/about')}>Why support this project? <span aria-hidden="true">↗</span></a>
        </div>
    </section>
  );
}
