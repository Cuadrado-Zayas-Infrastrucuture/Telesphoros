// Local synthetic experiment only. This adapter is never imported by production source.
const {createHash}=require('node:crypto');
const {readFile,mkdtemp,writeFile,rm,realpath}=require('node:fs/promises');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {TextCaptureRunner,UnsupportedSourceError,RunnerMisconfiguredError}=require('../../apps/backend/dist/lab-reports/runner/text-capture-runner');
const run=promisify(execFile);
const hash=b=>createHash('sha256').update(b).digest('hex');
const PDF_HASH='6b6d2a4578ac5ca2ac49db080d440320f3341b81ea0b81a7e29113a166c893f0';
const options={timeout:5000,maxBuffer:1024*1024,encoding:'buffer',env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}};
class LocalPopplerRunner extends TextCaptureRunner {
 name='poppler';
 static async open(binary=process.env.LOCAL_POPPLER_BINARY || 'pdftotext'){
  try{
   const executable=await new Promise((resolve,reject)=>{execFile('which',[binary],{encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(stdout.trim()));});
   const path=await realpath(executable);const binaryHash=hash(await readFile(path));
   const result=await run(path,['-v'],options);
   if(!/^pdftotext version 26\.03\.0\r?\n/.test(result.stderr.toString('utf8')))throw new Error();
   const r=new LocalPopplerRunner();r.binary=path;r.binaryHash=binaryHash;
   r.manifestSha256=hash(JSON.stringify({format:'local-poppler-synthetic/1',binaryHash,version:'26.03.0',args:['-layout','-enc','UTF-8'],allowedPdf:PDF_HASH,offsets:'Unicode scalar values; BOM counted; form feeds retained',maxBytes:10485760,timeoutMs:5000,maxOutputBytes:1048576}));return r;
  }catch{throw new RunnerMisconfiguredError('local-poppler-installation');}
 }
 async capture(pdf){
  if(pdf.length>10485760 || pdf.subarray(0,5).toString('ascii')!=='%PDF-')throw new UnsupportedSourceError();
  if(hash(pdf)!==PDF_HASH)throw new UnsupportedSourceError(); // Unknown, scanned, mixed or OCR-derived sources are not authorized.
  if(hash(await readFile(this.binary))!==this.binaryHash)throw new RunnerMisconfiguredError('local-poppler-build-changed');
  let dir;
  try{
   dir=await mkdtemp(join(tmpdir(),'telesphoros-poppler-'));await writeFile(join(dir,'source.pdf'),pdf,{mode:0o600});
   const {stdout}=await run(this.binary,['-layout','-enc','UTF-8',join(dir,'source.pdf'),'-'],options);
   const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(stdout);
   return {text,popplerVersion:'26.03.0'};
  }catch{throw new RunnerMisconfiguredError('local-poppler-extraction');}
  finally{if(dir)await rm(dir,{recursive:true,force:true});} // Only this invocation's exclusive temporary directory.
 }
}
module.exports={LocalPopplerRunner,PDF_HASH};
