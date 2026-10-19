'use strict';
const assert = require('assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const L=require('./lib/local-profile');
const S=require('./lib/secrets');
const a={bankId:'synthetic',questions:[{id:'a',prompt:'Why does ice melt?',difficulty:'core',keyPoints:['energy']},{id:'b',prompt:'What changes?',difficulty:'intro',keyPoints:['state']}]};
const b=structuredClone(a);b.questions[0].keyPoints=['Heat supplies energy'];b.questions[0].gradingContext={courseExplanation:'Energy changes the state.'};
L.validateAlternative(a,b);
for(const change of [x=>x.questions[0].prompt+=' changed',x=>x.questions.reverse(),x=>x.questions[0].difficulty='stretch',x=>x.bankId='other']){
 const bad=structuredClone(b);change(bad);assert.throws(()=>L.validateAlternative(a,bad));
}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'local-course-discovery-'));
try{
 fs.mkdirSync(path.join(tmp,'course','scratch'),{recursive:true});
 fs.writeFileSync(path.join(tmp,'course','course.json'),JSON.stringify({courseId:'actual'}));
 fs.writeFileSync(path.join(tmp,'course','scratch','course.json'),JSON.stringify({courseId:'snapshot'}));
 assert.deepEqual(S.allCourses(tmp).map(c=>c.courseId),['actual']);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log('Local alternate-bank and course-discovery contracts: 6 passed');

// Exercise the real builder: selecting a local alternative in a mixed course
// must neither query the unused remote backend nor include its credentials.
const {spawnSync}=require('child_process'),crypto=require('crypto');
const ROOT=path.resolve(__dirname,'..'),source=path.join(ROOT,'autograder','source');
const lab=fs.mkdtempSync(path.join(os.tmpdir(),'local-profile-package-'));
const saved=new Map();
for(const n of ['course.json','local-profile.json']){
 const p=path.join(source,n);if(fs.existsSync(p))saved.set(n,fs.readFileSync(p));
}
const bankdir=path.join(source,'banks');
if(fs.existsSync(bankdir)) for(const n of fs.readdirSync(bankdir)){
 assert(n.endsWith('.json'),'Only bank JSON files belong in the generated bank directory');
 saved.set('banks/'+n,fs.readFileSync(path.join(bankdir,n)));
}
try{
 fs.mkdirSync(path.join(lab,'banks'));
 fs.writeFileSync(path.join(lab,'banks','original.json'),JSON.stringify(a));
 fs.writeFileSync(path.join(lab,'banks','enhanced.json'),JSON.stringify(b));
 fs.writeFileSync(path.join(lab,'.env'),'ORALSCALE_SECRET='+crypto.randomBytes(32).toString('hex')+'\n',{mode:0o600});
 const course={courseId:'synthetic-local-profile',defaults:{limitSec:120,gradingBackend:'genai'},assignments:{
   'quiz-01':{bank:'banks/original.json',localModel:'qwen2.5-3b',regrades:{enhanced:{id:'enhanced',gradingBackend:'local',localModel:'qwen3.5-4b',bank:'banks/enhanced.json'}}},
   'quiz-02':{bank:'banks/original.json',gradingBackend:'genai'}}};
 fs.writeFileSync(path.join(lab,'course.json'),JSON.stringify(course));
 const run=spawnSync(process.execPath,[path.join(ROOT,'tools/build-autograder.js'),path.join(lab,'course.json'),'--zip','--assignment','quiz-01','--regrade','enhanced'],
  {encoding:'utf8',timeout:30000,env:{...process.env,GENAI_STUDIO_BASE_URL:'http://127.0.0.1:9',GENAI_STUDIO_API_KEY:'test-only-placeholder-value',GENAI_STUDIO_MODEL:'synthetic'}});
 assert.equal(run.status,0,run.stderr);
 assert(!/could not confirm|live model list/.test(run.stdout+run.stderr),'Unused remote model must not be checked');
 const zip=path.join(lab,'autograders',fs.readdirSync(path.join(lab,'autograders')).find(n=>n.endsWith('.zip')));
 const entry=n=>{const r=spawnSync('unzip',['-p',zip,n],{encoding:'utf8'});assert.equal(r.status,0);return r.stdout;};
 const c=JSON.parse(entry('course.json')),m=JSON.parse(entry('local-profile.json'));
 assert.deepEqual(Object.keys(c.assignments),['quiz-01']);
 assert.equal(c.assignments['quiz-01'].gradingBackend,'local');assert.equal(c.assignments['quiz-01'].localModel,'qwen3.5-4b');
 assert.equal(m.profile,L.PROFILE);assert.equal(m.assignmentId,'quiz-01');
 assert.equal(JSON.parse(entry(c.assignments['quiz-01'].bank)).questions[0].keyPoints[0],'Heat supplies energy');
 const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
 assert.equal(sha(entry('course.json')),m.courseSha256);
 assert.equal(sha(entry(c.assignments['quiz-01'].bank)),m.bankSha256);
 for(const [n,h] of Object.entries(m.sources)) assert.equal(sha(entry(n)),h,n);
 const settings=entry('secret.env');assert(!settings.includes('GENAI_STUDIO_'));assert(settings.includes('ORALSCALE_LOCAL_MODEL_KEY=qwen3.5-4b'));
 assert(settings.includes('ORALSCALE_LOCAL_REQUIRED=1'));assert(!settings.includes('ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR'));
 console.log('Versioned local package: selected assignment, alternate bank, profile/hash provenance and credential scope passed');
 const normalHash=sha(fs.readFileSync(zip));
 const debugRun=spawnSync(process.execPath,[path.join(ROOT,'tools/build-autograder.js'),path.join(lab,'course.json'),'--zip','--assignment','quiz-01','--regrade','enhanced','--debug-identity'],
   {encoding:'utf8',timeout:30000});
 assert.equal(debugRun.status,0,debugRun.stderr);assert(/DEBUG AUTOGRADER/.test(debugRun.stderr));
 assert.equal(sha(fs.readFileSync(zip)),normalHash,'DEBUG build must not overwrite normal artifact');
 const debugZip=path.join(lab,'autograders',fs.readdirSync(path.join(lab,'autograders')).find(n=>n.endsWith('-DEBUG-identity-flag-only.zip')));
 const debugEntry=n=>{const r=spawnSync('unzip',['-p',debugZip,n],{encoding:'utf8'});assert.equal(r.status,0);return r.stdout;};
 const dc=JSON.parse(debugEntry('course.json'));
 assert.deepEqual(dc.debugAutograder,{identityCheck:'flag-only',assignmentId:'quiz-01',label:'DEBUG — instructor testing only; do not publish these marks'});
 delete dc.debugAutograder;assert.deepEqual(dc,c,'Only generated DEBUG metadata may differ');
 assert.equal(debugEntry(c.assignments['quiz-01'].bank),entry(c.assignments['quiz-01'].bank));
 assert(!debugEntry('secret.env').includes('ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR'));
 const dm=JSON.parse(debugEntry('local-profile.json'));assert.equal(dm.profile,m.profile);assert.deepEqual(dm.sources,m.sources);
 const bad=spawnSync(process.execPath,[path.join(ROOT,'tools/build-autograder.js'),path.join(lab,'course.json'),'--zip','--debug-identity'],{encoding:'utf8'});
 assert.notEqual(bad.status,0);assert(/explicit --assignment/.test(bad.stderr));
 course.debugAutograder={identityCheck:'flag-only',assignmentId:'quiz-01'};
 fs.writeFileSync(path.join(lab,'course.json'),JSON.stringify(course));
 const refuse=spawnSync(process.execPath,[path.join(ROOT,'tools/build-autograder.js'),path.join(lab,'course.json')],{encoding:'utf8'});
 assert.notEqual(refuse.status,0);assert(/not a course setting/.test(refuse.stderr));
 console.log('DEBUG package: separate filename, same grader/bank, scoped flag-only identity, source-config refusal passed');

}finally{
 fs.rmSync(lab,{recursive:true,force:true});
 fs.rmSync(bankdir,{recursive:true,force:true});fs.mkdirSync(bankdir,{recursive:true});
 for(const n of ['course.json','local-profile.json'])fs.rmSync(path.join(source,n),{force:true});
 for(const [n,data] of saved)fs.writeFileSync(path.join(source,n),data);
}
