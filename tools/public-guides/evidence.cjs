const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const publicRoot='docs/public/';
const shots=['quiz-key.png','say-code.png','answer.png','app-overview.png','download.png'].map(n=>publicRoot+'site/assets/'+n);
const ui=['web/index.html','web/css/style.css','web/js/app.js','web/js/recorder.js','web/js/config.js','web/js/richtext.mjs','tools/public-guides/capture.cjs','tools/public-guides/evidence.cjs'];
function read(p){if(path.isAbsolute(p)||p.split('/').includes('..')||/accommodation|roster|\.keys\.csv/i.test(p))throw Error('Source outside public-guide scope');return fs.readFileSync(path.join(root,p));}
function sha(v){return crypto.createHash('sha256').update(v).digest('hex');}
function hashes(paths){return Object.fromEntries(paths.map(p=>[p,sha(read(p))]));}
function write(p,obj){fs.writeFileSync(path.join(root,p),JSON.stringify(obj,null,2)+'\n');}
function renderInputs(){return [publicRoot+'content.json',publicRoot+'external-sources.json','tools/public-guides/build.cjs','tools/public-guides/render.cjs','tools/public-guides/evidence.cjs',...['index.html','student.html','faculty.html','guide.css','assets/favicon.svg'].map(p=>publicRoot+'site/'+p),...shots];}
function pdfInfo(buffer){const s=buffer.toString('latin1');if(!s.startsWith('%PDF-'))throw Error('Invalid PDF header');const pages=(s.match(/\/Type\s*\/Page\b/g)||[]).length;const boxes=[...s.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)];if(pages!==2||!boxes.length||boxes.some(m=>+m[1]!==612||+m[2]!==792))throw Error('Expected two US Letter pages in Chromium PDF');return {pages,widthPoints:612,heightPoints:792};}
module.exports={root,shots,ui,read,sha,hashes,write,renderInputs,pdfInfo};
