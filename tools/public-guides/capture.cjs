/* Actual app UI, synthetic responses only. Never connect to a live course. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const pw = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : require('playwright');
const root = path.resolve(__dirname, '../..');
const evidence = require('./evidence.cjs');
const out = path.join(root, 'docs/public/site/assets');
(async () => {
 const server = http.createServer((req,res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, 'web', '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(path.join(root,'web')+path.sep)) {res.writeHead(403); return res.end();}
  try {res.setHeader('Content-Type', file.endsWith('.css')?'text/css':/\.(m?js)$/.test(file)?'text/javascript':'text/html');res.end(fs.readFileSync(file));} catch {res.writeHead(404);res.end();}
 });
 await new Promise(r => server.listen(0,'127.0.0.1',r));
 const origin = `http://127.0.0.1:${server.address().port}`;
 const browser = await pw.chromium.launch({headless:true,channel:process.env.CHROME_CHANNEL || 'chrome',args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
 try {
  const ctx = await browser.newContext({viewport:{width:760,height:1050},deviceScaleFactor:2,permissions:['microphone']});
  const page = await ctx.newPage();
  let n = 1;
  await page.route('**/*', async route => {
   const u = new URL(route.request().url());
   if (u.origin !== origin) return route.abort();
   const response = {
    '/reveal': () => ({code:'4719',revealToken:'illustration-only',codeLeadSec:4,questionCount:3}),
    '/question': () => ({ready:true,qNumber:n,questionCount:3,qIndex:n-1,limitSec:120,bufferSec:20,questionToken:'illustration-only',question:{id:`sample-${n}`,prompt:n===1?'Two plants receive the same amount of water, but only one gets sunlight. How would you explain the difference in their growth?':n===2?'Why might you repeat an experiment before drawing a conclusion?':'How could you check whether an explanation fits the evidence?'}}),
    '/closing': () => n < 3 ? {more:true,code:'5826',answered:n++,nextQNumber:n,nextRevealToken:'illustration-only'} : {more:false,code:'8032',answered:n,tailLimitSec:8,closingToken:'illustration-only'},
    '/finish': () => ({certificate:{courseId:'public-demo',assignmentId:'quiz-01'},certificateToken:'illustration-only'})
   }[u.pathname];
   if (response) return route.fulfill({json:response()});
   return route.continue();
  });
  const payload = Buffer.from(JSON.stringify({kind:'course',courseId:'public-demo',courseTitle:'OralScale demonstration',assignmentId:'quiz-01',assignmentLabel:'Practice quiz',pseudonymSalt:'public-demo-only',signerUrl:origin,requireKey:true})).toString('base64url');
  await page.goto(origin+'/#'+payload+'.illustration-only');
  await page.locator('#identityCard').waitFor({state:'visible'});
  await page.locator('#identityCard').screenshot({path:path.join(out,'quiz-key.png')});
  await page.locator('#keyInput').fill('XXXX-XXXX-XXXX-XXXX');
  await page.locator('#identityNext').click();
  await page.locator('#startBtn').click();
  await page.locator('#nonceVal').filter({hasText:'4 7 1 9'}).waitFor();
  await page.locator('#recordCard').screenshot({path:path.join(out,'say-code.png')});
  await page.locator('#qBox').waitFor({state:'visible'});
  await page.locator('#recordCard').screenshot({path:path.join(out,'answer.png')});
  await page.locator('main').screenshot({path:path.join(out,'app-overview.png')});
  for(let i=0;i<3;i++) {
   await page.locator('#stopBtn').click();
   if(i<2) await page.locator('#qPrompt').filter({hasText:i===0?'repeat an experiment':'fits the evidence'}).waitFor();
  }
  await page.locator('#stopBtnLabel').filter({hasText:'Finish & submit'}).waitFor();
  await page.locator('#stopBtn').click();
  await page.locator('#reviewCard').waitFor({state:'visible'});
  await page.locator('#reviewCard').screenshot({path:path.join(out,'download.png')});
  evidence.write('docs/public/screenshots.json',{kind:'Actual app renderer with synthetic responses; no live course or personal data',inputs:evidence.hashes(evidence.ui),outputs:evidence.hashes(evidence.shots)});
  console.log('Captured five app screenshots using synthetic demonstration responses. No live course accessed.');
 } finally {await browser.close(); server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
