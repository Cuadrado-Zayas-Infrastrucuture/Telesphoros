import { useState, type CSSProperties } from 'react';
import { ArrowRight, Check, FileText, Minus, Upload } from 'lucide-react';
import { useLandingLanguage } from '@/lib/landing/landing-language';
import '@/styles/landing-workflow.css';

const records = [
  { name: 'SYN-001.vcf', type: 'VCF', format: 'Variant Call Format', uploaded: true },
  { name: 'SYN-002.json', type: 'JSON', format: 'JSON', uploaded: false },
] as const;
/** An invented, shortened value that only illustrates what the server compares. It is labelled fictional on screen. */
const fictionalDigest = 'SHA-256 9f2c…41ad';

/** A state-only walkthrough. It never uploads, fetches, interprets, or downloads a report. */
export function LandingProductPreview() {
  const { workflow: w } = useLandingLanguage().copy;
  const steps = w.steps;
  const [step, setStep] = useState(0);
  const [format, setFormat] = useState(0);
  const [incomplete, setIncomplete] = useState(false);
  const [selected, setSelected] = useState(0);
  const scene = steps[step];
  const record = records[selected];

  return (
    <figure className="workflow-demo" data-reveal="2">
      <ol className="workflow-steps" aria-label={w.group} style={{ '--workflow-step': step } as CSSProperties}>
        {steps.map((item, index) => (
          <li key={item.label}>
            <button type="button" aria-pressed={step === index} aria-controls="workflow-scene" onClick={() => setStep(index)}>
              <span className="workflow-step-number" aria-hidden="true">
                0{index + 1}
              </span>
              <span>{item.label}</span>
              <ArrowRight aria-hidden="true" className="workflow-step-arrow" />
            </button>
          </li>
        ))}
      </ol>
      <section id="workflow-scene" className="workflow-scene" aria-labelledby="workflow-scene-title">
        <div className="workflow-story">
          <p className="workflow-kicker">{w.kicker(step + 1)}</p>
          <div aria-live="polite" aria-atomic="true">
            <h3 id="workflow-scene-title">{scene.title}</h3>
            <p className="workflow-description">{scene.description}</p>
          </div>
          <button type="button" className="workflow-next" onClick={() => setStep((step + 1) % steps.length)}>
            {step === 2 ? w.restart : w.next(steps[step + 1].label)}
            <ArrowRight aria-hidden="true" className="size-4" />
          </button>
        </div>
        <div className="workflow-example">
          <div className="workflow-example-heading">
            <span>{w.headings[step]}</span>
            <span>{w.fictional}</span>
          </div>
          {step === 0 && (
            <div className="workflow-intake">
              <div className="workflow-field">
                <span>{w.patientLabel}</span>
                <strong>{w.patient}</strong>
                <span className="workflow-field-note">{w.patientNote}</span>
              </div>
              <div className="workflow-format">
                <span>{w.tryFormat}</span>
                <div>
                  {records.map((item, index) => (
                    <button key={item.type} type="button" aria-pressed={format === index} onClick={() => setFormat(index)}>
                      {item.type}
                    </button>
                  ))}
                </div>
              </div>
              <div aria-live="polite">
                <div key={format} className="workflow-file">
                  <div className="workflow-file-art" aria-hidden="true">
                    <FileText />
                    <span>.{records[format].type.toLowerCase()}</span>
                  </div>
                  <div>
                    <strong>{records[format].name}</strong>
                    <p>{records[format].format}</p>
                    <span>{w.sampleFile}</span>
                  </div>
                  <Upload aria-hidden="true" className="workflow-file-upload" />
                </div>
              </div>
              <p className="workflow-example-note">{w.intakeNote}</p>
            </div>
          )}
          {step === 1 && (
            <div className="workflow-check">
              <div className={`workflow-check-result${incomplete ? ' workflow-check-incomplete' : ''}`} aria-live="polite">
                {incomplete ? <Minus aria-hidden="true" /> : <Check aria-hidden="true" />}
                <p>{w.uploaded}</p>
                <h4>{incomplete ? w.notComplete : w.serverVerified}</h4>
                <span>{w.sample}</span>
              </div>
              <dl className="workflow-checklist">
                <div>
                  <dt>{w.reportRecord}</dt>
                  <dd>{w.registered}</dd>
                </div>
                <div>
                  <dt>{w.storedFile}</dt>
                  <dd>{incomplete ? w.notVerified : w.verified}</dd>
                </div>
                <div>
                  <dt>{w.digest}</dt>
                  <dd>{incomplete ? w.notAvailable : w.fictionalDigest(fictionalDigest)}</dd>
                </div>
              </dl>
              <button type="button" className="workflow-compare" aria-pressed={incomplete} onClick={() => setIncomplete(!incomplete)}>
                {w.compare}
                <ArrowRight aria-hidden="true" className="size-4" />
              </button>
              <p className="workflow-example-note" aria-live="polite">
                {incomplete ? w.incompleteNote : w.verifiedNote}
              </p>
            </div>
          )}
          {step === 2 && (
            <div className="workflow-inspect">
              <div className="workflow-records" aria-label={w.recordsLabel}>
                {records.map((item, index) => (
                  <button key={item.name} type="button" aria-pressed={selected === index} aria-controls="landing-file-detail" onClick={() => setSelected(index)}>
                    <FileText aria-hidden="true" className="size-5" />
                    <span>{item.name}</span>
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </button>
                ))}
              </div>
              <section id="landing-file-detail" className="workflow-details" aria-labelledby="landing-detail-title" aria-live="polite" aria-atomic="true">
                <div key={selected} className="workflow-details-body">
                  <p>{w.selected}</p>
                  <h4 id="landing-detail-title">{record.name}</h4>
                  <dl>
                    <div>
                      <dt>{w.format}</dt>
                      <dd>{record.format}</dd>
                    </div>
                    <div>
                      <dt>{w.recordStatus}</dt>
                      <dd>{w.received}</dd>
                    </div>
                    <div>
                      <dt>{w.fileUploaded}</dt>
                      <dd className={record.uploaded ? 'workflow-success' : undefined}>{record.uploaded ? w.yesVerified : w.noIncomplete}</dd>
                    </div>
                  </dl>
                  <div className="workflow-detail-note">
                    <strong>{record.uploaded ? w.uploadVerified : w.uploadIncomplete}</strong>
                    <p>{record.uploaded ? w.storedVerifiedNote : w.metadataOnly}</p>
                  </div>
                </div>
              </section>
            </div>
          )}
          <p className="workflow-boundary">{scene.boundary}</p>
        </div>
      </section>
      <figcaption>
        <strong>{w.captionTitle}</strong>
        <span>{w.caption}</span>
      </figcaption>
    </figure>
  );
}
