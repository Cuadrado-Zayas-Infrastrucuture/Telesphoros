import { Fragment, useEffect, useRef } from 'react';
import { MascotWelcome } from '@/components/MascotWelcome';
import { LandingActions } from './LandingActions';
import { LandingParticles } from './LandingParticles';
import { PatientLinkFragment } from './PatientLinkFragment';
import { FileStatusFragment } from './FileStatusFragment';
import { AssistantFragment } from './AssistantFragment';
import { HeroBackdrop } from './HeroBackdrop';
import { HeroReportCard } from './HeroReportCard';
import { useLandingMotion } from '@/hooks/useLandingMotion';
import { useLandingLanguage } from '@/lib/landing/landing-language';
import '@/styles/landing.css';
import '@/styles/landing-motion.css';

/** Lines of a heading, joined by the `<br />` the design uses between them. */
const lines = (parts: readonly string[]) =>
  parts.map((part, index) => (
    <Fragment key={part}>
      {index > 0 && <br />}
      {part}
    </Fragment>
  ));

export function ProductLanding({ canUpload, signedIn }: { canUpload: boolean; signedIn: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useLandingMotion(root);
  const { language, copy } = useLandingLanguage();
  // Tell the browser and assistive technology which language the page is in; leaving the landing restores English.
  useEffect(() => {
    document.documentElement.lang = language;
    return () => {
      document.documentElement.lang = 'en';
    };
  }, [language]);
  const { hero, purpose, capabilities, questions, closing } = copy;
  return (
    <div ref={root} className="product-landing">
      <section className="landing-hero" aria-labelledby="home-title">
        <HeroBackdrop />
        <div className="landing-hero-shade" aria-hidden="true"></div>
        <LandingParticles placement="hero" />
        <div className="landing-wrap landing-hero-content">
          <div className="landing-hero-text">
            <p className="landing-eyebrow" data-reveal="1">
              {hero.eyebrow}
            </p>
            <h1 id="home-title" className="landing-headline">
              <span className="landing-line">
                <span>{hero.headline[0]}</span>
              </span>{' '}
              <span className="landing-line">
                <span>{hero.headline[1]}</span>
              </span>
            </h1>
            <p className="landing-hero-copy" data-reveal="2">
              {hero.copy}
            </p>
            <LandingActions canUpload={canUpload} signedIn={signedIn} reveal={3} />
            <p className="landing-preview-note" data-reveal="4">
              {hero.note[0]}
              <br className="landing-mobile-break" />
              {hero.note[1]}
            </p>
          </div>
          <div className="landing-hero-visual" data-reveal="2">
            <HeroReportCard />
          </div>
        </div>
        <div className="landing-hero-bottom landing-wrap">
          <span>{hero.product}</span>
          <span className="landing-hero-index" aria-hidden="true">
            {hero.index}
            <span className="landing-cue">↓</span>
          </span>
        </div>
      </section>

      <section className="landing-purpose landing-wrap" aria-labelledby="purpose-title">
        <div data-reveal="1">
          <p className="landing-eyebrow">{purpose.eyebrow}</p>
          <h2 id="purpose-title">{purpose.title}</h2>
        </div>
        <div className="landing-purpose-copy" data-reveal="2">
          <p>{purpose.p1}</p>
          <p>{purpose.p2}</p>
          <div className="landing-purpose-today">
            <h3>{purpose.todayTitle}</h3>
            <p>{purpose.today}</p>
          </div>
          <a className="landing-purpose-source" href="https://www.genome.gov/about-genomics/educational-resources/fact-sheets/pharmacogenomics">
            {purpose.source} <span aria-hidden="true">↗</span>
          </a>
        </div>
      </section>

      <section id="platform" className="landing-capabilities-section" aria-labelledby="capabilities-title">
        <div className="landing-capabilities landing-wrap">
          <div className="landing-capability-intro" data-reveal="1">
            <p className="landing-eyebrow">{capabilities.eyebrow}</p>
            <h2 id="capabilities-title">{lines(capabilities.title)}</h2>
            <p>{capabilities.intro}</p>
          </div>
          <div className="landing-capability-rows">
            {capabilities.rows.map((row, index) => (
              <article key={row.title} data-reveal={index + 1}>
                <span className="landing-capability-number" aria-hidden="true">
                  0{index + 1}
                </span>
                <div>
                  <h3>{row.title}</h3>
                  <p>{row.text}</p>
                  <p className="landing-capability-note">{row.note}</p>
                  {index === 0 ? <PatientLinkFragment /> : index === 1 ? <FileStatusFragment /> : <AssistantFragment />}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-questions-section" id="questions" aria-labelledby="questions-title">
        <div className="landing-wrap landing-questions-grid">
          <div data-reveal="1">
            <p className="landing-eyebrow">{questions.eyebrow}</p>
            <h2 id="questions-title">{lines(questions.title)}</h2>
          </div>
          <div className="landing-questions">
            {questions.items.map((item, index) => (
              <details key={item.q} data-reveal={index + 1}>
                <summary>
                  {item.q}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-closing" aria-labelledby="closing-title">
        <LandingParticles placement="closing" />
        <div className="landing-wrap">
          <MascotWelcome context="landing" alt={closing.mascotAlt}>
            <p className="landing-eyebrow" data-reveal="1">
              {closing.eyebrow}
            </p>
            <h2 id="closing-title" data-reveal="1">
              {closing.title}
            </h2>
            <p data-reveal="2">{closing.text}</p>
            <p className="landing-closing-note" data-reveal="3">
              {closing.note}
            </p>
          </MascotWelcome>
        </div>
      </section>
    </div>
  );
}
