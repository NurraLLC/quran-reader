// "How and why": what the reader does, what it costs and where the money goes, the reward of
// helping (only well-graded sources, paraphrased in our own words, each linked to sunnah.com), and
// who makes it. The Quran ayah shown is fetched from the app's licensed text, never stored here.
import { useEffect, useState } from 'react';
import type { CreditView, SearchCard } from '../shared/contracts';
import { toQpcHafsEncoding } from '../shared/display-encoding';
import { NurraBadge } from './Nurra';
import { SharedHours } from './Sponsor';
import { access, type Access, u } from './net';
import { audioRoute, transcriptUse, SILENCE_CONTROL } from './privacy-copy';

const REPO = 'https://github.com/NurraLLC/quran-reader';

/** Hadith: the Arabic of the Prophet's words (classical text), our own English paraphrase, and the source. */
const NARRATIONS: Array<{ ar: string; en: string; ref: string; grade: string; url: string }> = [
  {
    ar: 'إِذَا مَاتَ الإِنْسَانُ انْقَطَعَ عَنْهُ عَمَلُهُ إِلاَّ مِنْ ثَلاَثَةٍ: إِلاَّ مِنْ صَدَقَةٍ جَارِيَةٍ، أَوْ عِلْمٍ يُنْتَفَعُ بِهِ، أَوْ وَلَدٍ صَالِحٍ يَدْعُو لَهُ',
    en: 'When a person dies, their deeds come to an end except three: ongoing charity (sadaqah jariyah), knowledge that people keep benefiting from, and a righteous child who prays for them.',
    ref: 'Sahih Muslim 1631',
    grade: 'sahih',
    url: 'https://sunnah.com/muslim:1631',
  },
  {
    ar: 'مَنْ دَلَّ عَلَى خَيْرٍ فَلَهُ مِثْلُ أَجْرِ فَاعِلِهِ',
    en: 'Whoever leads someone to a good deed has a reward like the one who does it.',
    ref: 'Sahih Muslim 1893',
    grade: 'sahih',
    url: 'https://sunnah.com/muslim:1893',
  },
  {
    ar: 'مَنْ قَرَأَ حَرْفًا مِنْ كِتَابِ اللَّهِ فَلَهُ بِهِ حَسَنَةٌ، وَالْحَسَنَةُ بِعَشْرِ أَمْثَالِهَا',
    en: 'Whoever recites a letter of the Book of Allah has a good deed for it, and a good deed is multiplied ten times.',
    ref: 'Jami` at-Tirmidhi 2910',
    grade: 'hasan',
    url: 'https://sunnah.com/tirmidhi:2910',
  },
  {
    ar: 'خَيْرُكُمْ مَنْ تَعَلَّمَ الْقُرْآنَ وَعَلَّمَهُ',
    en: 'The best of you are those who learn the Quran and teach it.',
    ref: 'Sahih al-Bukhari 5027',
    grade: 'sahih',
    url: 'https://sunnah.com/bukhari:5027',
  },
];

export function About() {
  const [me, setMe] = useState<Access | null>(null);
  const [ayah, setAyah] = useState<SearchCard | null>(null);

  useEffect(() => {
    document.documentElement.dataset.surface = 'reader';
    document.title = 'Why we built this · Quran Reader';
    access()
      .then((a) => {
        setMe(a);
        return fetch(u('/api/verse/2:261'), { credentials: 'same-origin' });
      })
      .then((r) => (r.ok ? r.json() : null))
      .then((c: SearchCard | null) => c && setAyah(c))
      .catch(() => undefined);
  }, []);

  const credits: CreditView | undefined = me?.credits;
  const donations = me?.billing?.donations ?? [];

  return (
    <div className="reader about">
      <header className="r-top">
        <a className="about-back" href={u('/')}>
          ‹ Quran Reader
        </a>
        <NurraBadge />
      </header>
      <main className="r-page about-page">
        <h1>Why we built this</h1>
        <p className="about-lead">
          Quran Reader listens as you recite and keeps your place: the ayah you’re on appears as you reach it, with the meaning of each word, on your phone or on your stream. It’s free, and it’s made by Nurra.
        </p>
        <a className="about-support" href="#support">Support Quran Reader ↓</a>

        <section>
          <h2>Why</h2>
          <p>
            Whether you recite from memory or read along, it helps when the page keeps your place. We wanted that for everyone: the student revising their hifz, the person who wants to understand each word as they recite, the qari sharing their tilawah on a stream. No account, no ads, and nothing standing between anyone and the Quran.
          </p>
        </section>

        <section>
          <h2>A starting point for Muslim creators</h2>
          <p>We want more Muslims to feel able to start a stream, give a talk, or share their recitation. The OBS overlay puts the ayah and its translation alongside your video, so people can follow the Quran you’re reciting.</p>
          <p>You can also use the reading screen for a study circle or a community gathering. Open it on another screen so the people with you can read along.</p>
          <p>One reason we built this is to recite on a stream while raising support for an organization we care about. You can do that too: use the overlay, and direct viewers to that organization’s own fundraiser.</p>
          <p className="about-fine">When online contributions are available here, they support Quran Reader itself. They are separate from any fundraiser a creator runs for another organization.</p>
          <a href={u('/control')}>Open the overlay controls →</a>
        </section>

        <section>
          <h2>More Muslim spaces, built by us</h2>
          <p>We need more places where Muslims can learn, create, and spend time together. Getting started is easier when useful tools are already there.</p>
          <p>This began as something we wanted to use ourselves. We’re sharing it so someone else can start their first recitation stream, bring a Quran reading into a gathering, or build something we haven’t thought of.</p>
          <p>That is the infrastructure we want to help build: practical tools the community can use as a starting point. Quran Reader is one small part of it. The code is open, and you’re welcome to build on it.</p>
        </section>

        <section>
          <h2>How it works</h2>
          <ul>
            <li>Listening starts only when you turn on the microphone. {audioRoute(me?.mode ?? null)} {transcriptUse(me?.mode ?? null)} {SILENCE_CONTROL} <a href={u('/privacy.html')}>Privacy details</a>.</li>
            <li>It follows your place as you recite; it doesn’t grade recitation or mark mistakes.</li>
            <li>Arabic text, word meanings and transliteration: <a href="https://quran.com">Quran.com</a> (<a href="https://quran.foundation">Quran Foundation</a>). English translation: Saheeh International (Dar Abul-Qasim). Arabic font: KFGQPC HAFS Uthmanic Script, by the King Fahd Glorious Quran Printing Complex. The reader never generates scripture or translations.</li>
            <li>The code is open. Anyone can read it, check it, or run their own copy for free: <a href={REPO}>github.com/NurraLLC/quran-reader</a>.</li>
          </ul>
        </section>

        <section id="support">
          <h2>Support Quran Reader</h2>
          <p>Keeping the reader available has ongoing hosting costs, even when nobody is listening. Voice recognition is estimated at about 12 cents per hour and billed by token usage; AI requests, payment fees and other running costs are additional. See <a href="https://soniox.com/pricing" target="_blank" rel="noreferrer">Soniox’s pricing</a>.</p>
          <ul>
            <li>Listening is free for everyone. There are no accounts and no plans.</li>
            <li>Listening draws from a shared pool funded by community contributions, including our own. Daily limits help more people share those hours.</li>
            <li>Community support covers Quran Reader’s own running costs. We show the shared budget as estimated listening-hour equivalents. Listening, payment fees, hosting, and other recorded running costs reduce that balance. Actual listening time is shown separately.</li>
            <li>If the sponsored hours ever run out, listening pauses until someone gives again. Reading and search never stop.</li>
            <li>No accounts, no ads, no selling data, and no public donor names.</li>
          </ul>
          <p>When online contributions are available, payments go to Nurra LLC to support this service. They are voluntary, one-time contributions, not tax-deductible charitable donations.</p>
          {credits && <SharedHours stats={me?.sponsored} donations={donations} testMode={me?.billing?.testMode} defaultOpen />}
          {me?.mode === 'local' && <p className="r-support-status">This is a self-hosted copy. It uses your own listening service and doesn’t collect contributions.</p>}
        </section>

        <section>
          <h2>The reward of giving</h2>
          <p>
            Reward is with Allah, and we can’t promise anything on His behalf; it is the intention that counts. These are the ayah and ahadith that remind us why this matters. The ayah uses Saheeh International’s translation; the hadith translations are paraphrased, with links to their sources.
          </p>
          {ayah && (
            <figure className="about-text">
              <p className="about-ar about-quran" lang="ar" dir="rtl">{toQpcHafsEncoding(ayah.arabic)}</p>
              <figcaption>
                <p>{ayah.english}</p>
                <span className="about-ref">Quran, {ayah.surahName} {ayah.key} · Saheeh International</span>
              </figcaption>
            </figure>
          )}
          {NARRATIONS.map((n) => (
            <figure key={n.ref} className="about-text">
              <p className="about-ar" lang="ar" dir="rtl">{n.ar}</p>
              <figcaption>
                <p>{n.en}</p>
                <a className="about-ref" href={n.url} target="_blank" rel="noopener">
                  {n.ref} ({n.grade}) · sunnah.com
                </a>
              </figcaption>
            </figure>
          ))}
          <p className="about-fine">Gradings are as given on sunnah.com. We left out narrations graded da’if (weak), including a well-known one about leaving behind a mushaf.</p>
        </section>

        <section>
          <h2>Who we are</h2>
          <p>
            Quran Reader is operated by Nurra LLC, a project of <a href="https://nurra.org">Nurra</a>, building technology for the ummah. If you spot a mistake or have an idea, please tell us on <a href={`${REPO}/issues`}>GitHub</a>.
          </p>
        </section>

        <footer className="r-brand">
          <NurraBadge />
          <a href={u('/')}>Open the reader</a>
          <a href={u('/privacy.html')}>Privacy</a>
          <a href={u('/terms.html')}>Terms</a>
        </footer>
      </main>
    </div>
  );
}
