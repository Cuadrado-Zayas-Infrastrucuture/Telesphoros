import { useRef } from 'react';
import { MascotWelcome } from '@/components/MascotWelcome';
import { LandingActions } from './LandingActions';
import { LandingProductPreview } from './LandingProductPreview';
import { LandingParticles } from './LandingParticles';
import { PatientLinkFragment } from './PatientLinkFragment';
import { FileStatusFragment } from './FileStatusFragment';
import { AssistantFragment } from './AssistantFragment';
import { useLandingMotion } from '@/hooks/useLandingMotion';
import '@/styles/landing.css';
import '@/styles/landing-motion.css';

export function ProductLanding({ canUpload, signedIn }: { canUpload: boolean; signedIn: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useLandingMotion(root);
  return <div ref={root} className="product-landing">
  <section className="landing-hero" aria-labelledby="home-title">
    <div className="landing-hero-shade" aria-hidden="true"></div>
    <LandingParticles placement="hero" />
    <div className="landing-wrap landing-hero-content">
      <p className="landing-eyebrow" data-reveal="1">Pharmacogenomic report software</p>
      <h1 id="home-title" className="landing-headline"><span className="landing-line"><span>A clearer view of</span></span>{' '}<span className="landing-line"><span>your PGx reports.</span></span></h1>
      <p className="landing-hero-copy" data-reveal="2">Explore patient-linked uploads, file details, and upload status in the Telesphoros development preview.</p>
      <LandingActions canUpload={canUpload} signedIn={signedIn} reveal={3} />
      <p className="landing-preview-note" data-reveal="4">Development preview. Synthetic data only.<br className="landing-mobile-break" /> Not for clinical use.</p>
    </div>
    <div className="landing-hero-bottom landing-wrap"><span>A product of Cuadrado Zayas Infrastructure</span><span className="landing-hero-index" aria-hidden="true">Explore the workspace below <span className="landing-cue">↓</span></span></div>
  </section>

  <section className="landing-purpose landing-wrap" aria-labelledby="purpose-title">
    <div data-reveal="1"><p className="landing-eyebrow">Why we’re building Telesphoros</p><h2 id="purpose-title">Working toward less trial-and-error prescribing.</h2></div>
    <div className="landing-purpose-copy" data-reveal="2">
      <p>People respond differently to medicines. Pharmacogenomics examines how genetic differences influence that response, alongside other factors that matter in care.</p>
      <p>Our goal is to help clinicians and pharmacists bring pharmacogenomic information into prescribing decisions.</p>
      <div className="landing-purpose-today"><h3>Where we are today</h3><p>This development preview starts with patient-linked reports and verified file storage. Clinical interpretation and prescribing recommendations are not available.</p></div>
      <a className="landing-purpose-source" href="https://www.genome.gov/about-genomics/educational-resources/fact-sheets/pharmacogenomics">About pharmacogenomics · NHGRI <span aria-hidden="true">↗</span></a>
    </div>
  </section>

  <section className="landing-workspace-section landing-wrap" id="workflow" aria-labelledby="workspace-title">
    <div className="landing-section-heading" data-reveal="1"><div><p className="landing-eyebrow">Inside Telesphoros</p><h2 id="workspace-title">Add a report.<br />Know what’s stored.</h2></div><p className="landing-section-description">Follow a synthetic report through the storage workflow—from selecting a patient to checking the uploaded file.</p></div>
    <LandingProductPreview />
  </section>

  <section id="platform" className="landing-capabilities-section" aria-labelledby="capabilities-title"><div className="landing-capabilities landing-wrap">
    <div className="landing-capability-intro" data-reveal="1"><p className="landing-eyebrow">Available in this preview</p><h2 id="capabilities-title">Built around<br />the report.</h2><p>Patient-linked intake, file information, and a separate look at the assistant interface.</p></div>
    <div className="landing-capability-rows">
      <article data-reveal="1"><span className="landing-capability-number" aria-hidden="true">01</span><div><h3>Keep the patient and report connected.</h3><p>Select an existing synthetic patient before uploading. Standard intake accepts VCF and JSON; the storage workspace also accepts PDF.</p><p className="landing-capability-note">Uploads require a clinician role.</p><PatientLinkFragment /></div></article>
      <article data-reveal="2"><span className="landing-capability-number" aria-hidden="true">02</span><div><h3>Find a file. Check its status.</h3><p>In the storage workspace, filter reports by patient and open a record to see its format and upload status. Download a verified file when your role permits.</p><p className="landing-capability-note">File verification confirms storage, not clinical review.</p><FileStatusFragment /></div></article>
      <article data-reveal="3"><span className="landing-capability-number" aria-hidden="true">03</span><div><h3>Meet the PGx assistant preview.</h3><p>Explore sample questions and fixed example responses in a separate local demonstration. Uploaded reports are not analyzed.</p><p className="landing-capability-note">Development-only interface. No live AI or prescribing recommendations.</p><AssistantFragment /></div></article>
    </div>
  </div></section>

  <section className="landing-questions-section" id="questions" aria-labelledby="questions-title"><div className="landing-wrap landing-questions-grid">
    <div data-reveal="1"><p className="landing-eyebrow">Before you begin</p><h2 id="questions-title">Access and<br />preview questions.</h2></div>
    <div className="landing-questions">
      <details data-reveal="1"><summary>Who can access Telesphoros?<span aria-hidden="true">+</span></summary><p>Access is by invitation. Ask your organization’s administrator for an account. Signing in does not change your existing permissions.</p></details>
      <details data-reveal="2"><summary>Can I upload real patient reports?<span aria-hidden="true">+</span></summary><p>No. Use synthetic records only. This environment is not approved for clinical use, and real patient information must not be entered or uploaded.</p></details>
      <details data-reveal="3"><summary>What does “verified” mean?<span aria-hidden="true">+</span></summary><p>It means the server verified the stored file. It does not mean the report has been clinically interpreted or that a treatment recommendation has been established.</p></details>
      <details data-reveal="4"><summary>Does Telesphoros recommend a medication?<span aria-hidden="true">+</span></summary><p>No. Less trial-and-error prescribing is our direction, not an outcome established by this preview. It does not recommend medications or doses, and is not for clinical use.</p></details>
      <details data-reveal="5"><summary>Does the assistant interpret my reports?<span aria-hidden="true">+</span></summary><p>No. The assistant interface is a separate local development preview with fixed synthetic responses. It is not connected to the selected patient or report.</p></details>
    </div>
  </div></section>

  <section className="landing-closing" aria-labelledby="closing-title"><LandingParticles placement="closing" /><div className="landing-wrap"><MascotWelcome context="landing"><p className="landing-eyebrow" data-reveal="1">Telesphoros</p><h2 id="closing-title" data-reveal="1">Take a look inside Telesphoros.</h2><p data-reveal="2">Sign in with your existing account to explore the development preview using synthetic records.</p><LandingActions canUpload={canUpload} signedIn={signedIn} reveal={3} /><p className="landing-closing-note" data-reveal="4">Access is by invitation.</p></MascotWelcome></div></section>
</div>;
}
