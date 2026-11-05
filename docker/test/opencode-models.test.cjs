const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const {once}=require('node:events');
async function plugin() {
 const source=await fs.readFile(require('node:path').join(__dirname,'../examples/opencode-plugins/agy-models.js'),'utf8');
 return (await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).AgyModels;
}
async function fixture(t,handler){const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.close();server.closeAllConnections();});return `http://127.0.0.1:${server.address().port}/v1`;}
test('discovers all models, removes stale entries and repairs only Agy defaults',async t=>{
 const baseURL=await fixture(t,(req,res)=>{assert.equal(req.url,'/v1/models');assert.equal(req.headers.authorization,'Bearer private-key');res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'agy-default',name:'Default'},{id:'new-model',name:'New model'},{id:'__proto__'},{id:'agy-image'}]}));});
 const config={model:'agy/old-model',small_model:'other/model',provider:{agy:{options:{baseURL:baseURL+'/',apiKey:'private-key'},models:{'old-model':{},'new-model':{limit:{context:1000},options:{max_tokens:100}}}},other:{models:{keep:{}}}}};
 await (await(await plugin())()).config(config);
 assert.deepEqual(Object.keys(config.provider.agy.models),['agy-default','new-model']);assert.equal(config.model,'agy/agy-default');assert.equal(config.small_model,'other/model');assert.equal(config.provider.agy.models['new-model'].options.max_tokens,null);assert.equal(config.provider.agy.models['new-model'].limit.context,1000);assert.ok(config.provider.other.models.keep);
});
test('failed discovery preserves the original config and never logs response body or key',async t=>{
 const logs=[];const baseURL=await fixture(t,(req,res)=>{res.writeHead(401);res.end('SECRET_BODY');});
 const config={provider:{agy:{options:{baseURL,apiKey:'SECRET_KEY'},models:{existing:{}}}}};const before=JSON.stringify(config);
 await (await(await plugin())({client:{app:{log:async data=>logs.push(data)}}})).config(config);
 assert.equal(JSON.stringify(config),before);assert.equal(logs.length,1);assert.ok(!JSON.stringify(logs).includes('SECRET'));
});
test('invalid or empty model lists cannot wipe configured models',async t=>{
 const baseURL=await fixture(t,(req,res)=>{res.setHeader('content-type','application/json');res.end('{"data":[]}');});const config={provider:{agy:{options:{baseURL,apiKey:'key'},models:{existing:{}}}}};
 await (await(await plugin())()).config(config);assert.ok(config.provider.agy.models.existing);
});
