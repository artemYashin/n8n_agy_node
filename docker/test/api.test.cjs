const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {OpenAI}=require('openai');
const {createApp}=require('../build/server.cjs');
const key='test-key-123456789';
const request={model:'agy-default',messages:[{role:'user',content:'Hello'}]};
async function fixture(t,runAgy,extra={}) {
 const backend={runAgy,listModels:async()=>[{name:'Model',value:'model-1'}],cancelLogin:()=>true};
 const server=createApp({apiKey:key,backend,...extra}); server.listen(0,'127.0.0.1'); await once(server,'listening');
 t.after(()=>server.stop()); const base=`http://127.0.0.1:${server.address().port}`;
 return {base,client:new OpenAI({apiKey:key,baseURL:base+'/v1',maxRetries:0}),post:(body)=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body)})};
}
const result=(response)=>({response,usage:{input_tokens:2,output_tokens:3,total_tokens:5}});
test('health, setup, authentication, models and SDK completion',async t=>{
 const {base,client}=await fixture(t,async()=>result('Hello'));
 assert.equal((await fetch(base+'/healthz')).status,200);
 assert.equal((await fetch(base+'/')).status,200);
 assert.equal((await fetch(base+'/v1/models')).status,401);
 assert.equal((await client.models.list()).data[1].id,'model-1');
 const response=await client.chat.completions.create(request);
 assert.equal(response.choices[0].message.content,'Hello'); assert.equal(response.usage.total_tokens,5);
});
test('SDK receives deltas before backend finishes, with usage', {timeout:5000},async t=>{
 let finish; const gate=new Promise(resolve=>finish=resolve); t.after(()=>finish());
 const {client}=await fixture(t,async options=>{options.onText('live');await gate;options.onText(' answer');return result('live answer');});
 const stream=await client.chat.completions.create({...request,stream:true,stream_options:{include_usage:true}});
 let content='',usage;
 for await(const chunk of stream){const delta=chunk.choices[0]?.delta.content; if(delta){content+=delta;finish();} if(chunk.usage)usage=chunk.usage;}
 assert.equal(content,'live answer'); assert.equal(usage.total_tokens,5);
});
test('stops spanning chunks and invalid requests',async t=>{
 const {client,post}=await fixture(t,async options=>{options.onText?.('hello ST');options.onText?.('OP hidden');return result('hello STOP hidden');});
 const stream=await client.chat.completions.create({...request,stream:true,stop:'STOP'});let text='';for await(const chunk of stream)text+=chunk.choices[0]?.delta.content||'';
 assert.equal(text,'hello ');assert.equal((await post({...request,temperature:0.5})).status,400);
});
test('function calls and omitted assistant content',async t=>{
 const {client,post}=await fixture(t,async()=>result(JSON.stringify({content:'',tool_calls:[{name:'lookup',arguments:{city:'Paris'}}]})));
 const tools=[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}}];
 const response=await client.chat.completions.create({...request,tools,tool_choice:'required'});
 assert.equal(response.choices[0].finish_reason,'tool_calls');
 const call=response.choices[0].message.tool_calls[0];assert.equal(call.function.arguments,'{"city":"Paris"}');
 assert.equal((await post({...request,tools,messages:[...request.messages,{role:'assistant',tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:'sunny'}]})).status,200);
 tools[0].function.parameters.properties.city.type='number';assert.equal((await post({...request,tools})).status,502);
});
test('upstream diagnostics are redacted',async t=>{
 const {post}=await fixture(t,async()=>{throw Error('SECRET code token');});const response=await post(request);assert.equal(response.status,502);assert.ok(!(await response.text()).includes('SECRET'));
});
test('queue saturation and timeout abort',async t=>{
 let entered;const started=new Promise(resolve=>entered=resolve);let aborted=false;
 const {post}=await fixture(t,async(o,p,s,signal)=>{entered();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));},{concurrency:1,maxQueue:0,timeoutMs:250});
 const first=post(request);await started;assert.equal((await post(request)).status,429);assert.equal((await first).status,504);assert.equal(aborted,true);
});
