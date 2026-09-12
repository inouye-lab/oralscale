/* INV-DOC-1 / t_public_guides: a drift gate, not an automatic editorial sign-off. */
const fs=require('node:fs');const assert=require('node:assert/strict');
const E=require('./evidence.cjs');
const {outputs}=require('./build.cjs');
const json=p=>JSON.parse(E.read(p));
function groups(){
 const c=json('docs/public/content.json');const result={};
 for(const audience of ['student','faculty']){
  const g=c[audience];if(!g||g.steps.length!==5||g.faqs.length<1||g.faqs.length>8)throw Error('Expected five steps and at most eight FAQs per audience');
  const section=(name,value,sources)=>{
   if(!sources?.length)throw Error(`Missing source mapping for ${name}`);
   const paths=sources.map(s=>{if(!c.sources[s])throw Error(`Unknown source ${s}`);return c.sources[s];});
   result[name]={content:E.sha(JSON.stringify(value)),sources:E.hashes(paths)};
  };
  section(audience+'.quickstart',{steps:g.steps,intro:g.intro,needs:g.needs,reminder:g.reminder,screens:g.screens,starterPrompt:g.starterPrompt,workflow:g.workflow},g.quickstartSources);
  const seen=new Set();for(const f of g.faqs){if(seen.has(f.id))throw Error('Duplicate FAQ ID');seen.add(f.id);section(audience+'.faq.'+f.id,f,f.sources);}
 }
 result.presentation=E.hashes(['LICENSE','docs/public/content.json','docs/public/site/guide.css','tools/public-guides/build.cjs','tools/public-guides/check.cjs','tools/public-guides/evidence.cjs','docs/public/GOVERNANCE.md','models/08-measurement-model.md']);
 return result;
}
function differences(expected,actual,prefix=''){
 const errors=[];
 for(const key of new Set([...Object.keys(expected||{}),...Object.keys(actual||{})])){
  if(JSON.stringify(expected?.[key])!==JSON.stringify(actual?.[key]))errors.push(`${prefix}${key}`);
 }return errors;
}
function verifyEvidence(){
 const errors=[];
 for(const [file,inputs,outputs] of [
  ['screenshots.json',E.ui,E.shots],
  ['render.json',E.renderInputs(),['docs/public/site/student-guide.pdf','docs/public/site/faculty-guide.pdf']]
 ]){
  const receipt=json('docs/public/'+file);
  errors.push(...differences(receipt.inputs,E.hashes(inputs),file+' input: '));
  errors.push(...differences(receipt.outputs,E.hashes(outputs),file+' output: '));
 }
 for(const [name,html] of Object.entries(outputs()))if(E.read('docs/public/site/'+name).toString()!==html)errors.push(`Rebuild ${name}`);
 for(const audience of ['student','faculty'])E.pdfInfo(E.read(`docs/public/site/${audience}-guide.pdf`));
 const ext=json('docs/public/external-sources.json');
 const date=Date.parse(ext.reviewedOn);if(!Number.isFinite(date)||Date.now()-date>ext.reviewBeforeDays*86400000)errors.push('Review external Gradescope guidance (six-month review due)');
 return errors;
}
function check(){
 const errors=verifyEvidence();
 const receipt=json('docs/public/review.json');
 if(!receipt.reviewer||!receipt.note)errors.push('Missing editorial review acknowledgement');
 errors.push(...differences(receipt.groups,groups(),'Review needed: '));
 errors.push(...differences(receipt.artifacts,E.hashes([...E.shots,'docs/public/site/student-guide.pdf','docs/public/site/faculty-guide.pdf']),'Artifact changed: '));
 return errors;
}
if(require.main===module){try{
 if(process.argv.includes('--acknowledge')){
  const value=flag=>process.argv[process.argv.indexOf(flag)+1];
  if(!process.argv.includes('--reviewer')||!process.argv.includes('--note')||!value('--reviewer')||!value('--note'))throw Error('Use --acknowledge --reviewer NAME --note "what was reviewed" only after review and regeneration.');
  const errors=verifyEvidence();if(errors.length)throw Error(errors.join('\n'));
  E.write('docs/public/review.json',{reviewer:value('--reviewer'),note:value('--note'),reviewedOn:new Date().toISOString().slice(0,10),groups:groups(),artifacts:E.hashes([...E.shots,'docs/public/site/student-guide.pdf','docs/public/site/faculty-guide.pdf'])});
  console.log('Recorded public-guide editorial review.');
 }else{
  // ADVISORY BY DEFAULT, BLOCKING AT RELEASE (instructor, 2026-09-12). Day-to-day commits to
  // main only get suggested guide updates; the review becomes a gate on an official release
  // (`--release`, run by CI on a v* tag). Malformed content.json still throws in both modes.
  const release=process.argv.includes('--release')||process.env.ORALSCALE_GUIDES_RELEASE==='1';
  const errors=check();
  if(errors.length&&release)throw Error(errors.join('\n'));
  if(errors.length){
   console.log('Public guides: suggested review before the next release (advisory, not blocking):\n'
    +errors.map(e=>'  - '+e).join('\n')
    +'\nCheck whether the mapped FAQs are still true. Before an official release run '
    +'`npm run test:guides:release`, which blocks until the review is acknowledged.');
   return;
  }
  if(!process.argv.includes('--no-self-test')) {
   // Run the real gate in an isolated public-only fixture, then introduce actual drift.
   const os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
   const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oralscale-guide-test-'));
   try {
    const c=json('docs/public/content.json');
    const files=new Set([...E.ui,...E.shots,...E.renderInputs(),...Object.values(c.sources),
     ...Object.keys(groups().presentation),'tools/public-guides/check.cjs',
     ...['screenshots.json','render.json','review.json','site/student-guide.pdf','site/faculty-guide.pdf'].map(p=>'docs/public/'+p)]);
    for(const file of files){const dest=path.join(dir,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,E.read(file));}
    const run=()=>cp.spawnSync(process.execPath,[path.join(dir,'tools/public-guides/check.cjs'),'--no-self-test','--release'],{encoding:'utf8'});
    const clean=run();assert.equal(clean.status,0,clean.stderr);
    for(const file of ['LICENSE','models/03-state-machine.md','web/css/style.css','docs/public/site/assets/answer.png','docs/public/site/student-guide.pdf','docs/public/site/student.html']){
     const dest=path.join(dir,file),before=fs.readFileSync(dest);fs.appendFileSync(dest,'\nchanged');
     assert.equal(run().status,1,`Gate accepted drift in ${file}`);fs.writeFileSync(dest,before);
    }
    const contentPath=path.join(dir,'docs/public/content.json');
    const before=fs.readFileSync(contentPath);const changed=JSON.parse(before);
    changed.student.faqs[0].answer='Changed public advice';fs.writeFileSync(contentPath,JSON.stringify(changed));
    assert.equal(run().status,1,'Gate accepted changed FAQ');
    delete changed.student.faqs[0].sources;fs.writeFileSync(contentPath,JSON.stringify(changed));
    assert.equal(run().status,1,'Gate accepted FAQ without sources');
    fs.writeFileSync(contentPath,before);
    assert.throws(()=>E.pdfInfo(Buffer.from('%PDF- broken')));
    assert.throws(()=>E.read('../outside'));
   } finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
  console.log('t_public_guides PASS: source mappings, reviewed content, screenshot/PDF freshness, two Letter pages, generated HTML parity, and negative drift tests.');
 }
}catch(e){console.error('Public guides need attention:\n'+e.message);process.exitCode=1;}}
module.exports={check,groups,differences};
