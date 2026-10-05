// Self-hosted runs keep the private control link and the OBS overlay link across restarts, so a
// restart does not silently break the browser source in OBS. They live next to the other local
// state (git-ignored, excluded from the image), readable only by this user where the OS allows.
// "Replace overlay link" still rotates the overlay link, and the new one is saved.
//
// A restart (a crash, a closed terminal, an update) also keeps what the stream was showing: the
// owner's sign-in cookie secret, so the open control tab simply reconnects instead of asking for the
// private link again, and the ayah last shown with whether it was hidden, so OBS shows it again. Only
// the ayah's reference is kept, never what was heard. The cookie has the same trust as the owner link
// beside it: whoever can read this file can already open the control page.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DEFAULT_STYLE, DisplayStyleSchema, type DisplayStyle } from '../shared/contracts';

/** The ayah the audience was last shown, and whether the broadcaster had hidden it. */
export type ShownAyah = { key: string; hidden: boolean };
export type LocalLinks = { owner: string; view: string; cookie: string; style?: DisplayStyle; display?: ShownAyah | null };
export type SavedLinks = {
  links: LocalLinks;
  saveView: (view: string) => void;
  saveStyle: (style: DisplayStyle) => void;
  saveDisplay: (shown: ShownAyah | null) => void;
};

const token = (bytes: number) => randomBytes(bytes).toString('base64url');
const valid = (t: unknown, min: number): t is string => typeof t === 'string' && /^[A-Za-z0-9_-]+$/.test(t) && t.length >= min;
const shownAyah = (d: unknown): ShownAyah | null => {
  if (!d || typeof d !== 'object') return null;
  const { key, hidden } = d as { key?: unknown; hidden?: unknown };
  return typeof key === 'string' && /^\d{1,3}:\d{1,3}$/.test(key) && typeof hidden === 'boolean' ? { key, hidden } : null;
};

export function localLinks(file: string): SavedLinks {
  let links: LocalLinks | null = null;
  let repaired = false;
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<keyof LocalLinks, unknown>>;
      if (valid(j.owner, 32) && valid(j.view, 24)) {
        // Links saved before the cookie was kept get one now, once (24 random bytes, like the owner link).
        repaired = !valid(j.cookie, 32);
        links = { owner: j.owner, view: j.view, cookie: valid(j.cookie, 32) ? j.cookie : token(24) };
        const saved = DisplayStyleSchema.safeParse({ ...DEFAULT_STYLE, ...(j.style as object) });
        if (j.style && saved.success) links.style = saved.data;
        const shown = shownAyah(j.display);
        if (shown) links.display = shown;
      }
    } catch {
      links = null;
    }
  }
  // Frequent slider adjustments must not leave half-written capabilities if the process stops.
  const write = (l: LocalLinks) => {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(l), { mode: 0o600 });
    renameSync(temporary, file);
  };
  if (!links) {
    links = { owner: token(24), view: token(18), cookie: token(24) };
    write(links);
  } else if (repaired) write(links);
  const current = links;
  return {
    links: current,
    saveView: (view) => {
      current.view = view;
      write(current);
    },
    saveStyle: (style) => {
      current.style = DisplayStyleSchema.parse(style);
      write(current);
    },
    saveDisplay: (shown) => {
      current.display = shown ? { key: shown.key, hidden: shown.hidden } : null;
      write(current);
    },
  };
}

/**
 * What a self-hosted session takes from the saved links: its overlay link, its look and the ayah last
 * shown, and where each change is saved. main.ts and the restart test build sessions with it.
 */
export function savedSessionOptions(saved: SavedLinks) {
  return {
    viewToken: saved.links.view,
    onViewToken: saved.saveView,
    style: saved.links.style,
    onStyle: saved.saveStyle,
    initialDisplay: saved.links.display ?? null,
    onDisplayKey: saved.saveDisplay,
  };
}
