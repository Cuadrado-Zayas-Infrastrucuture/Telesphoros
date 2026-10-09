import d01Preview from '@/assets/local-D01.svg';
import { Link } from 'react-router-dom';
import { useState, useRef } from 'react';
import { captureDtoSchema, fileLinkDtoSchema, evaluationDtoSchema, type CaptureDto } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { usePageTitle } from '@/hooks/usePageTitle';
import { submitReport, localStorageOrigin, type UploadProgress } from '@/lib/localReportApi';

export default function LocalReviewPage() {
  usePageTitle('Local synthetic PDF review');
  const {apiFetch, roles} = useAuth();
  const [file,setFile]=useState<File>();
  const [label,setLabel]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const [captureId,setCaptureId]=useState('');
  const [capture,setCapture]=useState<CaptureDto>();
  const [pdf,setPdf]=useState(''); const [text,setText]=useState('');
  const [compared,setCompared]=useState(false);
  const [result,setResult]=useState(''); const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const progress=useRef<UploadProgress>({});
  async function json(path:string,body?:unknown) {
    if(!import.meta.env.DEV || window.location.hostname!=='127.0.0.1')throw new Error('Local experiment only.');
    const r=await apiFetch('/api/v1'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok)throw new Error(`Request refused (${r.status}). No approval is inferred.`);
    return r.json();
  }
  async function link(path:string){const value=fileLinkDtoSchema.parse(await json(path));if(new URL(value.url).origin!==localStorageOrigin())throw new Error('File destination is not the local emulator.');return value.url;}
  async function load(id:string){
    setCapture(undefined);setPdf('');setText('');setCompared(false);setResult('');
    const c=captureDtoSchema.parse(await json('/captures/'+id));
    const p=await link('/reports/'+c.reportId+'/download-url');
    const t=await link('/captures/'+c.id+'/text-url');
    const r=await fetch(t,{credentials:'omit',redirect:'error'});if(!r.ok)throw new Error('Stored text could not be loaded.');
    setText(await r.text());setPdf(p);setCapture(c);setCaptureId(c.id);
  }
  async function act(work:()=>Promise<void>){setBusy(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'Step failed.');}finally{setBusy(false);}}
  async function upload(){if(!file || !confirmed || !/^SYN-[A-Za-z0-9-]+$/.test(label))throw new Error('Choose a synthetic PDF, confirm it, and use a SYN- label.');const r=await submitReport({file,patientLabel:label,reportType:'lab-pdf',syntheticConfirmed:confirmed},apiFetch,progress.current);const c=captureDtoSchema.parse(await json('/reports/'+r.reference+'/capture',{}));await load(c.id);}
  async function decide(decision:'accepted'|'rejected'){if(!capture || !compared || !roles.includes('reviewer'))throw new Error('Reviewer comparison is required.');await json('/captures/'+capture.id+'/decision',{decision});await load(capture.id);}
  async function evaluate(){if(!capture || capture.latestDecision?.decision!=='accepted')throw new Error('Current accepted capture required.');const e=evaluationDtoSchema.parse(await json('/reports/'+capture.reportId+'/evaluations',{captureId:capture.id,acceptanceId:capture.latestDecision.id}));setResult(JSON.stringify(e,null,2));}
  return <main className="mx-auto max-w-6xl p-6 space-y-6">
    <h1 className="text-2xl">Local synthetic PDF review</h1><Link to="/local-upload">JSON and VCF upload</Link> <Link to="/local-operations">Evaluation history, corrections and disputes</Link>
    <p>Synthetic fixture only. Capture runner is shown below. Clinical use: not approved. Sign in as alice to upload, then sign out and sign in as gina to review. Copy the capture ID before switching.</p>
    <fieldset disabled={busy} className="space-y-3"><legend>1. Upload a known synthetic fixture</legend>
      <label className="block">Synthetic label <input aria-label="Synthetic label" value={label} onChange={e=>setLabel(e.target.value)} className="border p-2" /></label>
      <label className="block">PDF fixture <input aria-label="PDF fixture" type="file" accept=".pdf" onChange={e=>setFile(e.target.files?.[0])}/></label>
      <label className="block"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> This file contains synthetic data only</label>
      <button onClick={()=>void act(upload)} className="border p-2">Upload and capture</button>
    </fieldset>
    <fieldset disabled={busy}><legend>2. Open capture for comparison</legend><input aria-label="Capture ID" value={captureId} onChange={e=>setCaptureId(e.target.value)} className="border p-2"/><button className="border p-2" onClick={()=>void act(()=>load(captureId))}>Open capture</button></fieldset>
    {capture && <section className="space-y-3"><p>Capture ID: {capture.id}. Runner: {capture.runner}. Decision: {capture.latestDecision?.decision ?? 'pending'}.</p><div className="grid gap-4 md:grid-cols-2"><div><a href={pdf} target="_blank" rel="noreferrer">Open source PDF in a separate tab</a>{capture.pdfSha256==='6b6d2a4578ac5ca2ac49db080d440320f3341b81ea0b81a7e29113a166c893f0' ? <img src={d01Preview} alt="Rendered source PDF, D01 synthetic fixture" className="w-full"/> : <p>No registered preview. Open the original PDF above before reviewing.</p>}</div><pre className="h-96 overflow-auto border p-3 whitespace-pre-wrap">{text}</pre></div>
      <label className="block"><input type="checkbox" checked={compared} onChange={e=>setCompared(e.target.checked)}/> I compared the PDF and stored text, including field associations</label>
      <button disabled={busy || !compared || !roles.includes('reviewer')} className="border p-2" onClick={()=>void act(()=>decide('accepted'))}>Accept capture</button> <button disabled={busy || !compared || !roles.includes('reviewer')} className="border p-2" onClick={()=>void act(()=>decide('rejected'))}>Reject capture</button>
      <p>The API independently refuses decisions by anyone who created, uploaded, completed or captured this report.</p>
      <button disabled={busy || capture.latestDecision?.decision!=='accepted'} className="border p-2" onClick={()=>void act(evaluate)}>Run synthetic evaluation</button></section>}
    {error && <p role="alert">{error}</p>}{busy && <p role="status">Working locally…</p>}{result && <pre className="overflow-auto border p-3">{result}</pre>}
  </main>;
}
