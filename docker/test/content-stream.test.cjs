const {test}=require('node:test');const assert=require('node:assert/strict');
const {contentStream}=require('../src/content-stream.cjs');
function decode(parts){let text='';const parser=contentStream(delta=>text+=delta);for(const part of parts)parser.write(part);parser.end();return text;}
test('streams only top-level content across every chunk boundary',()=>{
 const content='Hello "world"\nПривет 🌍 \\ /\t';
 for(const body of [JSON.stringify({content,tool_calls:[]}),JSON.stringify({tool_calls:[{name:'test',arguments:{content:'SECRET',nested:[{x:'} \\"'}]}}],content})]) {
  for(let i=0;i<=body.length;i++)assert.equal(decode([body.slice(0,i),body.slice(i)]),content);
  assert.equal(decode(body.split('')),content);
 }
});
test('handles JSON unicode escapes, escaped keys and Markdown fences',()=>{
 const body='```json\n{"cont\\u0065nt":"Hello \\uD83C\\uDF0D \\u0410\\n","tool_calls":[]}\n```';
 for(let i=0;i<=body.length;i++)assert.equal(decode([body.slice(0,i),body.slice(i)]),'Hello 🌍 А\n');
 assert.equal(decode(body.split('')),'Hello 🌍 А\n');
});
test('does not leak nested strings, repeat duplicate content keys or expose non-JSON prose',()=>{
 assert.equal(decode(['{"tool_calls":[{"arguments":{"content":"SECRET"}}],"content":"ok"}']),'ok');
 assert.equal(decode(['{"content":"first","content":"second"}']),'first');
 assert.equal(decode(['Here is a response: {"content":"not streamed"}']),'');
 assert.equal(decode(['{"content":null,"tool_calls":[]}']),'');
});
