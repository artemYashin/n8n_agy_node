const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const fs=require('node:fs/promises');
const path=require('node:path');
const {tmpdir}=require('node:os');
const {randomUUID}=require('node:crypto');
const {OpenAI}=require('openai');
const {createApp,runImage,collectImage}=require('../build/server.cjs');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=';
async function fake(t){
 const root=await fs.mkdtemp(path.join(tmpdir(),'agy-image-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const brain=path.join(root,'brain');await fs.mkdir(brain);
 const executable=path.join(root,'fake.cjs');
 await fs.writeFile(executable,`#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');const {randomUUID}=require('node:crypto');
const brain=${JSON.stringify(brain)};let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 const prompt=JSON.parse(input).message.content;const id=randomUUID();const dir=path.join(brain,id);fs.mkdirSync(dir);
 fs.writeFileSync(path.join(brain,'workspace'),process.cwd());
 console.log(JSON.stringify({event:'init',conversation_id:id}));
 if(prompt==='hang'){setInterval(()=>{},1000);return;}
 if(prompt==='verify'){console.error('VALIDATION_REQUIRED https://accounts.google.com/verify?test=1');process.exitCode=1;return;}
 if(prompt!=='none')fs.writeFileSync(path.join(dir,'image.png'),Buffer.from(${JSON.stringify(png)},'base64'));
 console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'/outside/never-read.jpg',conversation_id:id}}));
});`,{mode:0o755});
 return {root,brain,executable};
}
test('real subprocess protocol returns image bytes and removes only its own artifacts',async t=>{
 const {brain,executable}=await fake(t);const existing=randomUUID();await fs.mkdir(path.join(brain,existing));
 const result=await runImage({prompt:'lake'},{executable,brainRoot:brain,timeoutMs:2000});
 assert.equal(result.data[0].b64_json,png);assert.equal(result.data[0].mime_type,'image/png');assert.equal(result.data[0].width,1);
 const entries=await fs.readdir(brain);assert.deepEqual(entries.sort(),[existing,'workspace'].sort());
 const workspace=await fs.readFile(path.join(brain,'workspace'),'utf8');await assert.rejects(fs.stat(workspace),{code:'ENOENT'});
});
test('missing image is an error even when CLI claims success',async t=>{
 const {brain,executable}=await fake(t);
 await assert.rejects(runImage({prompt:'none'},{executable,brainRoot:brain,timeoutMs:2000}),e=>e.code==='image_not_generated');
});
test('image subprocess verification and cancellation clean up request directories',async t=>{
 const {brain,executable}=await fake(t);
 await assert.rejects(runImage({prompt:'verify'},{executable,brainRoot:brain,timeoutMs:2000}),e=>e.code==='account_verification_required');
 const controller=new AbortController();const pending=runImage({prompt:'hang'},{executable,brainRoot:brain,timeoutMs:2000},controller.signal);
 const timer=setTimeout(()=>controller.abort(new Error('cancelled')),100);
 try {await assert.rejects(pending,/cancelled/);}finally{clearTimeout(timer);}
 assert.deepEqual(await fs.readdir(brain),['workspace']);
});
test('artifact collector ignores symlinks, stale images and untracked directories',async t=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'agy-image-path-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const id=randomUUID();const directory=path.join(root,id);await fs.mkdir(directory);
 const outside=path.join(root,'outside.png');await fs.writeFile(outside,Buffer.from(png,'base64'));
 await fs.symlink(outside,path.join(directory,'link.png'));
 await fs.writeFile(path.join(directory,'old.png'),Buffer.from(png,'base64'));await fs.utimes(path.join(directory,'old.png'),1,1);
 await assert.rejects(collectImage(root,new Set([id,'../outside']),Date.now()),e=>e.code==='image_not_generated');
});
async function api(t,handler,config={}) {
 const key='image-test-key-123456';const backend={cancelLogin:()=>{},runAgy:async()=>({response:'chat still works'}),listModels:async()=>[]};
 const server=createApp({apiKey:key,backend,runImage:handler,...config});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.stop());
 const url=`http://127.0.0.1:${server.address().port}/v1`;
 return {client:new OpenAI({apiKey:key,baseURL:url,maxRetries:0}),url,key};
}
test('OpenAI SDK image endpoint, validation, and authentication',async t=>{
 let calls=0;const {client,url}=await api(t,async(input)=>{calls++;assert.equal(input.prompt,'lake');return {created:1,data:[{b64_json:png,mime_type:'image/png',file_name:'generated-image.png',width:1,height:1}]};});
 const result=await client.images.generate({model:'agy-image',prompt:'lake',n:1,response_format:'b64_json'});
 assert.equal(result.data[0].b64_json,png);
 for(const params of [{n:2},{model:'gpt-image-1'},{size:'1024x1024'},{response_format:'url'},{prompt:''},{stream:true}])await assert.rejects(client.images.generate({model:'agy-image',prompt:'lake',...params}),e=>e.status===400);
 assert.equal((await fetch(url+'/images/generations',{method:'POST'})).status,401);assert.equal(calls,1);
});
test('image queue is separate from chat and enforces timeout and capacity',async t=>{
 let started;const entered=new Promise(resolve=>started=resolve);
 const {client}=await api(t,async(i,o,signal)=>{started();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},{imageConcurrency:1,imageMaxQueue:0,imageTimeoutMs:300});
 const first=client.images.generate({prompt:'lake'});const firstCheck=assert.rejects(first,e=>e.status===504);await entered;
 await assert.rejects(client.images.generate({prompt:'lake'}),e=>e.status===429);
 const text=await client.chat.completions.create({model:'agy-default',messages:[{role:'user',content:'hi'}]});assert.equal(text.choices[0].message.content,'chat still works');await firstCheck;
});
test('image verification errors use the existing account setup flow',async t=>{
 const {client}=await api(t,async()=>{throw Error('VALIDATION_REQUIRED https://accounts.google.com/verify?test=1');});
 await assert.rejects(client.images.generate({prompt:'lake'}),e=>e.status===403 && e.code==='account_verification_required');
});
