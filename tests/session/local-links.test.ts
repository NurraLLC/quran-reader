import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localLinks } from '../../src/server/local-links';
import { DEFAULT_STYLE } from '../../src/shared/contracts';

describe('self-hosted links', () => {
  it('survive a restart, and a replaced overlay link is kept', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qo-links-')), 'local-links.json');
    const first = localLinks(file);
    const again = localLinks(file);
    expect(again.links).toEqual(first.links);
    again.saveView('replacedOverlayLinkToken1234567');
    expect(localLinks(file).links.view).toBe('replacedOverlayLinkToken1234567');
    expect(localLinks(file).links.owner).toBe(first.links.owner);
  });

  it('are made fresh when the file is missing or damaged', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qo-links-')), 'local-links.json');
    writeFileSync(file, '{"owner":"short"}');
    const l = localLinks(file).links;
    expect(l.owner.length).toBeGreaterThanOrEqual(32);
    expect(JSON.parse(readFileSync(file, 'utf8')).owner).toBe(l.owner);
  });

  it('keeps the appearance through restarts and overlay-link replacement', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qo-look-')), 'local-links.json');
    const first = localLinks(file);
    const style = { ...DEFAULT_STYLE, englishScale: 1.4, captionPosition: 'top' as const, captionInset: 120, panelOpacity: 0.4 };
    first.saveStyle(style);
    const restarted = localLinks(file);
    expect(restarted.links.style).toEqual(style);
    restarted.saveView('replacementOverlayToken123456789');
    expect(localLinks(file).links).toMatchObject({ style, owner: first.links.owner, view: 'replacementOverlayToken123456789' });
  });

  it('keep the owner cookie and the ayah last shown through a restart', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qo-shown-')), 'local-links.json');
    const first = localLinks(file);
    expect(first.links.cookie).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(first.links.cookie).not.toBe(first.links.owner);
    expect(first.links.display ?? null).toBeNull();
    first.saveDisplay({ key: '67:2', hidden: false });
    const restarted = localLinks(file);
    expect(restarted.links.cookie).toBe(first.links.cookie);
    expect(restarted.links.display).toEqual({ key: '67:2', hidden: false });
    restarted.saveDisplay({ key: '67:2', hidden: true });
    expect(localLinks(file).links.display).toEqual({ key: '67:2', hidden: true });
    // A new look or a replaced overlay link keeps both.
    restarted.saveStyle({ ...DEFAULT_STYLE, englishScale: 1.2 });
    restarted.saveView('replacementOverlayToken123456789');
    expect(localLinks(file).links).toMatchObject({ owner: first.links.owner, cookie: first.links.cookie, display: { key: '67:2', hidden: true } });
    // Nothing on screen is kept too: a restart never brings back an ayah the screen had let go.
    restarted.saveDisplay(null);
    expect(localLinks(file).links.display ?? null).toBeNull();
    expect(localLinks(file).links.cookie).toBe(first.links.cookie);
  });

  it('give links saved before cookies were kept a cookie once, and ignore a damaged cookie or ayah', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qo-shown-')), 'local-links.json');
    const owner = 'ownerCapabilityFromAnOlderRun0123456789';
    const view = 'overlayLinkFromAnOlderRun01234';
    writeFileSync(file, JSON.stringify({ owner, view }));
    const upgraded = localLinks(file).links;
    expect(upgraded).toMatchObject({ owner, view });
    expect(upgraded.cookie).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(localLinks(file).links.cookie).toBe(upgraded.cookie); // created once, then kept
    writeFileSync(file, JSON.stringify({ ...upgraded, cookie: 'short' }));
    const repaired = localLinks(file).links;
    expect(repaired).toMatchObject({ owner, view });
    expect(repaired.cookie).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(repaired.cookie).not.toBe('short');
    for (const display of [{ key: '67:2<script>', hidden: false }, { key: '67:2', hidden: 'yes' }, '67:2', { key: 672, hidden: false }]) {
      writeFileSync(file, JSON.stringify({ ...repaired, display }));
      expect(localLinks(file).links).toMatchObject({ owner, view, cookie: repaired.cookie });
      expect(localLinks(file).links.display ?? null).toBeNull();
    }
  });

  it('loads old appearance records and ignores damaged settings without replacing valid links', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qo-look-')), 'local-links.json');
    const first = localLinks(file);
    const { englishScale, captionPosition, captionInset, panelOpacity, ...oldStyle } = DEFAULT_STYLE;
    writeFileSync(file, JSON.stringify({ ...first.links, style: { ...oldStyle, accent: '#5fbf98' } }));
    expect(localLinks(file).links.style).toEqual({ ...DEFAULT_STYLE, accent: '#5fbf98' });
    writeFileSync(file, JSON.stringify({ ...first.links, style: { ...DEFAULT_STYLE, captionInset: -900 } }));
    expect(localLinks(file).links).toEqual(first.links);
  });
});
