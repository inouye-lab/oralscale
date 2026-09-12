/* PDF is a print rendering of the canonical HTML; no duplicate document copy. */
const fs=require('node:fs');const path=require('node:path');
const pw=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):require('playwright');
const root=path.resolve(__dirname,'../..');
const evidence=require('./evidence.cjs');
const origin=process.env.GUIDE_PREVIEW_URL || 'http://127.0.0.1:8766';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname))throw Error('Use a local preview only');
(async()=>{
 const browser=await pw.chromium.launch({headless:true,channel:process.env.CHROME_CHANNEL || 'chrome'});
 try{
  const page=await browser.newPage();
  const failures=[];
  page.on('pageerror',e=>failures.push(e.message));
  page.on('response',r=>{if(r.status()>=400)failures.push(r.url()+': '+r.status());});
  for(const name of ['index','student','faculty']){
   await page.setViewportSize({width:1440,height:1050});
   await page.goto(`${origin}/${name}.html`,{waitUntil:'networkidle'});
   await page.evaluate(()=>document.fonts.ready);
   if(name==='faculty'){
    await page.context().grantPermissions(['clipboard-read','clipboard-write']);
    await page.getByRole('button',{name:'Copy prompt',exact:true}).click();
    const expected=await page.locator('#starter-prompt').textContent();
    const copied=await page.evaluate(()=>navigator.clipboard.readText());
    if(copied!==expected)throw Error('Starter prompt copy failed');
    const links=await page.locator('.resource-links a').evaluateAll(as=>as.map(a=>a.href));
    if(!links.some(h=>h.endsWith('/docs/guides/QUESTION-DESIGN-GUIDE.md')))throw Error('Missing question-design link');
   }

   const broken=await page.locator('img').evaluateAll(imgs=>imgs.some(i=>!i.complete||!i.naturalWidth));
   if(broken)throw Error(`${name}: missing image`);
   if(name!=='index'){
    const printChrome=await page.locator('.folio,.print-footer').evaluateAll(es=>es.some(e=>getComputedStyle(e).display!=='none'));
    if(printChrome)throw Error('Print-only headings or page numbers visible on screen');
    if(await page.locator('.paper').evaluateAll(es=>es.some(e=>getComputedStyle(e).borderTopWidth!=='0px')))throw Error('Paper framing on screen');
   }
   await page.screenshot({path:path.join(root,`tmp/public-guides/${name}-desktop.png`),fullPage:true});
   // Every local link must resolve, including downloads and fragment destinations.
   const hrefs=await page.locator('a[href]').evaluateAll(as=>as.map(a=>a.getAttribute('href')));
   for(const href of hrefs){
    if(href.startsWith('#')){if(!await page.locator(href).count())throw Error(`Missing anchor ${name}: ${href}`);}
    else if(!/^[a-z]+:/i.test(href) && !href.endsWith('.pdf')){
     const r=await page.request.get(new URL(href,page.url()).href);
     if(!r.ok())throw Error(`Broken link ${href}`);
    }
   }
   for(const width of [360,768]){
    await page.setViewportSize({width,height:900});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error(`${name}: horizontal overflow at ${width}`);
    await page.screenshot({path:path.join(root,`tmp/public-guides/${name}-${width}.png`),fullPage:true});
   }
   if(name!=='index'){
    await page.emulateMedia({media:'print'});
    await page.setViewportSize({width:720,height:976});
    const overflow=await page.locator('.paper').evaluateAll(els=>els.map(e=>({height:e.clientHeight,scroll:e.scrollHeight,footer:e.querySelector('.print-footer').getBoundingClientRect().top,last:e.querySelector('.takeaway,.source-note')?.getBoundingClientRect().bottom})).filter(e=>e.scroll>e.height+1||e.last>e.footer-6));
    if(overflow.length)throw Error(`${name}: print overflow ${JSON.stringify(overflow)}`);
    // Screenshot enlargement links are for the website, not local-server PDF annotations.
    await page.locator('.screens a').evaluateAll(as=>as.forEach(a=>a.removeAttribute('href')));
    await page.pdf({path:path.join(root,`docs/public/site/${name}-guide.pdf`),preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false,tagged:true,outline:true});
    await page.emulateMedia({media:'screen'});
   }
  }
  for(const name of ['student','faculty']){const r=await page.request.get(`${origin}/${name}-guide.pdf`);if(!r.ok())throw Error('Missing PDF download');}
  if(failures.length)throw Error(failures.join('\n'));
  const pdfs=['student','faculty'].map(n=>'docs/public/site/'+n+'-guide.pdf');
  evidence.write('docs/public/render.json',{inputs:evidence.hashes(evidence.renderInputs()),outputs:evidence.hashes(pdfs),pdfs:Object.fromEntries(pdfs.map(p=>[p,evidence.pdfInfo(evidence.read(p))])),checkedViewports:[360,768,1440],printOverflow:false});
  console.log('Desktop, 360px and 768px layouts passed; two matching guide PDFs generated.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
