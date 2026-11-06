const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {OpenAI}=require('openai');
const {createApp}=require('../build/server.cjs');
const key='test-key-123456789';
const request={model:'agy-default',messages:[{role:'user',content:'Hello'}]};
async function fixture(t,runAgy,extra={}) {
 const backend={runAgy,listModels:async()=>[{name:'Model',value:'model-1'}],cancelLogin:()=>true};
 const server=createApp({apiKey:key,backend,logRequests:false,...extra}); server.listen(0,'127.0.0.1'); await once(server,'listening');
 t.after(()=>server.stop()); const base=`http://127.0.0.1:${server.address().port}`;
 return {base,client:new OpenAI({apiKey:key,baseURL:base+'/v1',maxRetries:0}),post:(body)=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body)})};
}
const result=(response)=>({response,usage:{input_tokens:2,output_tokens:3,total_tokens:5}});
test('request logs include original bodies and request IDs without auth secrets',async t=>{
 const logs=[];
 const {base,post}=await fixture(t,async()=>result('ok'),{logRequests:true,requestLogger:line=>logs.push(JSON.parse(line))});
 const body={...request,messages:[{role:'system',content:'My system prompt'},...request.messages],stream:true};
 const response=await post(body); await response.text();
 assert.deepEqual(logs[0].body,body);
 assert.equal(logs[0].request_id,response.headers.get('x-request-id'));
 assert.equal(logs[0].path,'/v1/chat/completions');
 const send=(route,body,authorized=true)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:`Bearer ${key}`}:{})},body});
 await (await send('/admin/login/complete',JSON.stringify({code:'login-secret',nested:{api_key:'key-secret',refresh_token:'refresh-secret'}}))).text();
 assert.equal(logs[1].body.code,'[REDACTED]');
 assert.equal(logs[1].body.nested.api_key,'[REDACTED]');
 assert.equal(logs[1].body.nested.refresh_token,'[REDACTED]');
 await (await send('/unknown?token=query-secret',JSON.stringify({prompt:'rejected request'}),false)).text();
 assert.equal(logs[2].path,'/unknown');
 assert.equal(logs[2].body.prompt,'rejected request');
 await (await send('/v1/chat/completions','{"token":"malformed-secret"')).text();
 assert.equal(logs[3].body,'[omitted: invalid JSON or non-JSON body]');
 await (await send('/v1/chat/completions',JSON.stringify({prompt:'x'.repeat(1024*1024)}))).text();
 assert.equal(logs[4].body,'[omitted: body exceeds 1 MiB]');
 const serialized=JSON.stringify(logs);
 for(const secret of [key,'login-secret','key-secret','refresh-secret','query-secret','malformed-secret']) assert.ok(!serialized.includes(secret));
});
test('request logging can be disabled',async t=>{
 const logs=[];const {post}=await fixture(t,async()=>result('ok'),{logRequests:false,requestLogger:line=>logs.push(line)});
 await (await post(request)).text();assert.deepEqual(logs,[]);
});
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

test('only caller system/developer instructions reach the system prompt',async t=>{
 const captured=[];
 const {post}=await fixture(t,async(o,p,s)=>{captured.push({prompt:p,system:s});return result('ok');});
 await post(request);
 assert.deepEqual(captured[0],{prompt:'Hello',system:''});
 await post({...request,messages:[{role:'system',content:'My exact instructions.'},{role:'developer',content:'Use Russian.'},...request.messages]});
 assert.equal(captured[1].system,'My exact instructions.\n\nUse Russian.');
 await post({...request,response_format:{type:'json_object'},messages:[{role:'system',content:'Only mine.'},...request.messages]});
 assert.equal(captured[2].system,'Only mine.');
});
test('verification failures expose safe links in HTTP, SSE and authenticated setup status',async t=>{
 let fail=true;
 const url='https://accounts.google.com/verify?challenge=test';
 const {base,post}=await fixture(t,async()=>{if(fail)throw Error('SECRET diagnostic: VALIDATION_REQUIRED verify your account '+url);return result('ok');});
 const response=await post(request);assert.equal(response.status,403);
 const data=await response.json();assert.equal(data.error.code,'account_verification_required');assert.equal(data.error.verification_url,url);assert.ok(!JSON.stringify(data).includes('SECRET'));
 const status=await fetch(base+'/admin/status',{headers:{authorization:`Bearer ${key}`}}).then(r=>r.json());
 assert.equal(status.authenticated,true);assert.equal(status.verification.verification_url,url);
 assert.equal((await fetch(base+'/admin/status')).status,401);
 const stream=await post({...request,stream:true});const events=await stream.text();assert.match(events,/account_verification_required/);assert.match(events,/data: \[DONE\]/);
 fail=false;await post(request);
 const cleared=await fetch(base+'/admin/status',{headers:{authorization:`Bearer ${key}`}}).then(r=>r.json());assert.equal(cleared.verification,null);
});
test('verification without a trusted URL remains actionable without exposing diagnostics',async t=>{
 const {post}=await fixture(t,async()=>{throw Error('verify your account https://accounts.google.com.evil.example/secret SECRET');});
 const response=await post(request);assert.equal(response.status,403);const data=await response.json();assert.equal(data.error.verification_url,undefined);assert.ok(!JSON.stringify(data).includes('SECRET'));
});

test('Responses API reports the exact n8n setting to change',async t=>{
 const {base}=await fixture(t,async()=>result('unused'));
 const response=await fetch(base+'/v1/responses',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:'{}'});
 assert.equal(response.status,400);const data=await response.json();assert.equal(data.error.code,'unsupported_endpoint');assert.match(data.error.message,/turn off Use Responses API/);
});

test('OpenCode 2020-12 schemas validate arguments, including prefixItems',async t=>{
 let args={values:['ok']};
 const {post}=await fixture(t,async()=>result(JSON.stringify({content:'',tool_calls:[{name:'sample',arguments:args}]})));
 const tools=[{type:'function',function:{name:'sample',parameters:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{values:{type:'array',prefixItems:[{type:'string'}],items:false,minItems:1}},required:['values']}}}];
 assert.equal((await post({...request,tools})).status,200);
 args={values:[123]};assert.equal((await post({...request,tools})).status,502);
 args={values:['ok','extra']};assert.equal((await post({...request,tools})).status,502);
});

const streamTools=[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}}];
test('OpenCode-style request streams text before CLI finishes despite available tools',{timeout:5000},async t=>{
 let finish;const gate=new Promise(resolve=>finish=resolve);t.after(()=>finish());
 const {client}=await fixture(t,async options=>{
  options.onText('{"content":"Early text');await gate;
  options.onText(' and more","tool_calls":[]}');return result('{"content":"Early text and more","tool_calls":[]}');
 });
 const stream=await client.chat.completions.create({...request,tools:streamTools,stream:true});let content='';
 for await(const chunk of stream){const delta=chunk.choices[0]?.delta.content;if(delta){content+=delta;finish();}}
 assert.equal(content,'Early text and more');
});
test('streams prose without leaking tool argument JSON and emits validated calls only',async t=>{
 const envelope={content:'Checking now.',tool_calls:[{name:'lookup',arguments:{query:'private tool argument'}}]};
 const {client}=await fixture(t,async options=>{for(const char of JSON.stringify(envelope))options.onText(char);return result(JSON.stringify(envelope));});
 const stream=await client.chat.completions.create({...request,tools:streamTools,stream:true});let content='',call,finish;
 for await(const chunk of stream){content+=chunk.choices[0]?.delta.content||'';call=chunk.choices[0]?.delta.tool_calls?.[0]||call;finish=chunk.choices[0]?.finish_reason||finish;}
 assert.equal(content,envelope.content);assert.equal(call.function.name,'lookup');assert.equal(JSON.parse(call.function.arguments).query,'private tool argument');assert.equal(finish,'tool_calls');
});
test('invalid tool arguments are never emitted, even after streaming partial text',async t=>{
 const body=JSON.stringify({content:'Checking',tool_calls:[{name:'lookup',arguments:{query:123}}]});
 const {post}=await fixture(t,async options=>{options.onText(body);return result(body);});
 const response=await post({...request,tools:streamTools,stream:true});const wire=await response.text();
 assert.match(wire,/Checking/);assert.match(wire,/upstream_error/);assert.ok(!wire.includes('"tool_calls"'));assert.match(wire,/\[DONE\]/);
});
test('tool text fallback, stop boundaries and inconsistent final text',async t=>{
 let mode='fallback';
 const {post}=await fixture(t,async options=>{
  if(mode==='fallback')return result('{"content":"fallback","tool_calls":[]}');
  if(mode==='stop'){options.onText('{"content":"hello ST');options.onText('OP hidden","tool_calls":[]}');return result('{"content":"hello STOP hidden","tool_calls":[]}');}
  options.onText('{"content":"first","tool_calls":[]}');return result('{"content":"different","tool_calls":[]}');
 });
 const text=async body=>{const wire=await(await post(body)).text();return {wire,content:wire.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)).choices?.[0]?.delta.content||'').join('')};};
 assert.equal((await text({...request,tools:streamTools,stream:true})).content,'fallback');
 mode='stop';assert.equal((await text({...request,tools:streamTools,stream:true,stop:'STOP'})).content,'hello ');
 mode='mismatch';assert.match((await text({...request,tools:streamTools,stream:true})).wire,/differs from its final response/);
});
