const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const load=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'../examples',name),'utf8'));
const sub=load('telegram-image-tool.json'),main=load('telegram-image-agent.json');
const get=(flow,name)=>flow.nodes.find(node=>node.name===name);
const expression=(text,context)=>vm.runInNewContext('('+text.slice(3,-2).trim()+')',context);
const code=(text,item)=>vm.runInNewContext(`(function(){${text}})()`,{$input:{first:()=>({json:item})}});
test('workflow graphs reference existing nodes and do not ship credentials',()=>{
 for(const flow of [sub,main]){
  const names=new Set(flow.nodes.map(n=>n.name));assert.equal(names.size,flow.nodes.length);assert.equal(flow.active,false);
  for(const node of flow.nodes)assert.equal(node.credentials,undefined);
  for(const [name,outputs]of Object.entries(flow.connections)){assert.ok(names.has(name));for(const branches of Object.values(outputs))for(const edges of branches)for(const edge of edges)assert.ok(names.has(edge.node));}
 }
});
test('AI can set only image prompt; recipient is fixed by Telegram Trigger',()=>{
 const inputs=get(main,'generate_and_send_image').parameters.workflowInputs.value;
 const $=name=>{assert.equal(name,'Telegram Trigger');return {first:()=>({json:{message:{chat:{id:-123456}}}})};};
 assert.equal(expression(inputs.chat_id,{$}),'-123456');assert.ok(!inputs.chat_id.includes('$fromAI'));
 assert.equal(expression(inputs.prompt,{$fromAI:(name)=>{assert.equal(name,'prompt');return 'a lake';}}),'a lake');
 const chatId=get(sub,'Send Photo').parameters.chatId;
 assert.equal(expression(chatId,{$:()=>({first:()=>({json:{chat_id:'-123456'}})})}),'-123456');
 assert.equal(get(main,'OpenAI Chat Model').parameters.responsesApiEnabled,false);
});
test('HTTP request preserves prompt JSON and file metadata is passed to Telegram',()=>{
 const request=get(sub,'Generate Image');const prompt='A "boat"\n雪';
 const body=expression(request.parameters.jsonBody,{$json:{prompt}});assert.equal(body.prompt,prompt);assert.equal(body.model,'agy-image');assert.equal(request.retryOnFail,false);
 const file=get(sub,'Convert Image to File').parameters;
 assert.equal(file.sourceProperty,'data[0].b64_json');assert.equal(file.binaryPropertyName,'data');
 assert.equal(expression(file.options.mimeType,{$json:{data:[{mime_type:'image/png'}]}}),'image/png');
 assert.equal(get(sub,'Send Photo').parameters.binaryPropertyName,'data');
});
test('sub-workflow rejects invalid recipient and reports success only after photo delivery',()=>{
 const validator=get(sub,'Validate Input').parameters.jsCode;
 assert.equal(code(validator,{prompt:'lake',chat_id:-123})[0].json.chat_id,'-123');
 assert.throws(()=>code(validator,{prompt:'lake',chat_id:'@other'}),/chat_id/);
 assert.throws(()=>code(validator,{prompt:'',chat_id:'123'}),/prompt/);
 const status=get(sub,'Delivery Status').parameters.jsCode;
 const result=code(status,{ok:true,result:{message_id:42,photo:[{file_id:'abc'}]}})[0];
 assert.equal(result.json.sent,true);assert.equal(result.json.message_id,42);assert.equal(result.binary,undefined);assert.ok(!JSON.stringify(result).includes('abc'));
 assert.throws(()=>code(status,{ok:false,description:'failed'}),/confirm photo delivery/);
 assert.throws(()=>code(status,{}),/confirm photo delivery/);
});
