import { useState } from 'react';
import { ArrowRight, Check, FileText, Minus, Upload } from 'lucide-react';
import '@/styles/landing-workflow.css';

const steps = [
  { label: 'Upload', title: 'Start with the patient.', description: 'Select an existing synthetic patient and attach their report. The file is checked before submission.', boundary: 'Uploads require a clinician role.' },
  { label: 'Check', title: 'See whether the upload completed.', description: 'Check whether the server verified the stored file. A report record can exist even when its upload is incomplete.', boundary: 'File verification does not indicate clinical review.' },
  { label: 'Find', title: 'Find the record. Check the details.', description: 'In the storage workspace, browse reports by patient and open a record to see its format and upload status.', boundary: 'File retrieval follows your existing permissions. This example does not download files.' },
] as const;
const records = [
  { name: 'SYN-001.vcf', type: 'VCF', format: 'Variant Call Format', uploaded: true },
  { name: 'SYN-002.json', type: 'JSON', format: 'JSON', uploaded: false },
] as const;

/** A state-only walkthrough. It never uploads, fetches, interprets, or downloads a report. */
export function LandingProductPreview() {
  const [step, setStep] = useState(0);
  const [format, setFormat] = useState(0);
  const [incomplete, setIncomplete] = useState(false);
  const [selected, setSelected] = useState(0);
  const scene = steps[step];
  const record = records[selected];

  return <figure className="workflow-demo">
    <ol className="workflow-steps" aria-label="Explore the report workflow">
      {steps.map((item, index) => <li key={item.label}>
        <button type="button" aria-pressed={step === index} aria-controls="workflow-scene" onClick={() => setStep(index)}>
          <span className="workflow-step-number" aria-hidden="true">0{index + 1}</span>
          <span>{item.label}</span><ArrowRight aria-hidden="true" className="workflow-step-arrow" />
        </button>
      </li>)}
    </ol>
    <section id="workflow-scene" className="workflow-scene" aria-labelledby="workflow-scene-title">
      <div className="workflow-story">
        <p className="workflow-kicker">Explore step 0{step + 1} / 03</p>
        <div aria-live="polite" aria-atomic="true">
          <h3 id="workflow-scene-title">{scene.title}</h3>
          <p className="workflow-description">{scene.description}</p>
        </div>
        <button type="button" className="workflow-next" onClick={() => setStep((step + 1) % steps.length)}>{step === 2 ? 'Back to the beginning' : `Next: ${steps[step + 1].label.toLowerCase()}`}<ArrowRight aria-hidden="true" className="size-4" /></button>
      </div>
      <div className="workflow-example">
        <div className="workflow-example-heading"><span>{step === 0 ? 'Report intake' : step === 1 ? 'File verification' : 'Storage workspace'}</span><span>Fictional example</span></div>
        {step === 0 && <div className="workflow-intake">
          <div className="workflow-field"><span>Synthetic patient</span><strong>Example patient</strong><span className="workflow-field-note">An existing record, selected before upload</span></div>
          <div className="workflow-format"><span>Try a report format</span><div>{records.map((item, index) => <button key={item.type} type="button" aria-pressed={format === index} onClick={() => setFormat(index)}>{item.type}</button>)}</div></div>
          <div className="workflow-file" aria-live="polite"><div className="workflow-file-art" aria-hidden="true"><FileText /><span>.{records[format].type.toLowerCase()}</span></div><div><strong>{records[format].name}</strong><p>{records[format].format}</p><span>Synthetic sample file</span></div><Upload aria-hidden="true" className="workflow-file-upload" /></div>
          <p className="workflow-example-note">This example changes the file format only. No file is selected from your device or uploaded.</p>
        </div>}
        {step === 1 && <div className="workflow-check">
          <div className={`workflow-check-result${incomplete ? ' workflow-check-incomplete' : ''}`} aria-live="polite">
            {incomplete ? <Minus aria-hidden="true" /> : <Check aria-hidden="true" />}<p>File uploaded</p><h4>{incomplete ? 'Not complete' : 'Server verified'}</h4><span>SYN-001.vcf · Synthetic example</span>
          </div>
          <dl className="workflow-checklist"><div><dt>Report record</dt><dd>Registered</dd></div><div><dt>Stored file</dt><dd>{incomplete ? 'Not verified' : 'Verified'}</dd></div></dl>
          <button type="button" className="workflow-compare" aria-pressed={incomplete} onClick={() => setIncomplete(!incomplete)}>Compare an incomplete upload<ArrowRight aria-hidden="true" className="size-4" /></button>
          <p className="workflow-example-note" aria-live="polite">{incomplete ? 'The record exists, but the upload is not complete. A record alone does not confirm file storage.' : 'Verification confirms storage. Genotypes, phenotypes, and clinical interpretation are separate.'}</p>
        </div>}
        {step === 2 && <div className="workflow-inspect">
          <div className="workflow-records" aria-label="Fictional report records">{records.map((item, index) => <button key={item.name} type="button" aria-pressed={selected === index} aria-controls="landing-file-detail" onClick={() => setSelected(index)}><FileText aria-hidden="true" className="size-5" /><span>{item.name}</span><ArrowRight aria-hidden="true" className="size-4" /></button>)}</div>
          <section id="landing-file-detail" className="workflow-details" aria-labelledby="landing-detail-title" aria-live="polite" aria-atomic="true"><p>Selected report</p><h4 id="landing-detail-title">{record.name}</h4><dl><div><dt>Format</dt><dd>{record.format}</dd></div><div><dt>Record status</dt><dd>Received</dd></div><div><dt>File uploaded</dt><dd className={record.uploaded ? 'workflow-success' : undefined}>{record.uploaded ? 'Yes — server verified' : 'No — not complete'}</dd></div></dl><div className="workflow-detail-note"><strong>{record.uploaded ? 'Upload verified' : 'Upload not complete'}</strong><p>{record.uploaded ? 'The stored file was verified. This does not establish a clinical result.' : 'Only metadata is available. The file has not been marked uploaded.'}</p></div></section>
        </div>}
        <p className="workflow-boundary">{scene.boundary}</p>
      </div>
    </section>
    <figcaption><strong>Interactive illustration</strong><span>Interactive example using fictional records. No files are uploaded.</span></figcaption>
  </figure>;
}
