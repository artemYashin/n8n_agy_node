// Incrementally decode only the top-level `content` string in the tool envelope.
// Never forward JSON syntax or strings nested inside tool arguments to the UI.
function contentStream(emit) {
  let started=false, prefix='', depth=0, state='key', key='', quoted=false;
  let kind='', raw='', escape=false, unicode=null, disabled=false, seen=false, high='';
  const push = text => {
    text=high+text;high='';
    const last=text.charCodeAt(text.length-1);
    if(last>=0xd800 && last<=0xdbff){high=text.slice(-1);text=text.slice(0,-1);}
    if(text)emit(text);
  };
  return {
    write(chunk) {
      if(disabled)return;
      // Batch emissions per CLI event rather than per decoded character.
      let output='';
      for(const ch of chunk) {
        if(!started) {
          if(ch==='{') {
            if(!/^\s*(?:```(?:json)?\s*)?$/i.test(prefix)){disabled=true;break;}
            started=true;depth=1;continue;
          }
          prefix+=ch;if(prefix.length>100){disabled=true;break;}continue;
        }
        if(quoted) {
          if(unicode!==null) {
            if(!/[0-9a-f]/i.test(ch)){disabled=true;break;}
            unicode+=ch;
            if(unicode.length===4){if(kind==='content')output+=String.fromCharCode(parseInt(unicode,16));unicode=null;}
            if(kind==='key')raw+=ch;
            continue;
          }
          if(escape) {
            escape=false;
            if(kind==='key')raw+=ch;
            if(ch==='u'){unicode='';continue;}
            const escapes={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};
            if(!Object.hasOwn(escapes,ch)){disabled=true;break;}
            if(kind==='content')output+=escapes[ch];
            continue;
          }
          if(ch==='\\'){escape=true;if(kind==='key')raw+=ch;continue;}
          if(ch==='"') {
            quoted=false;
            if(kind==='key'){try{key=JSON.parse('"'+raw+'"');}catch{disabled=true;break;}state='colon';}
            else if(depth===1)state='after';
            continue;
          }
          if(ch.charCodeAt(0)<32){disabled=true;break;}
          if(kind==='key')raw+=ch;
          if(kind==='content')output+=ch;
          continue;
        }
        if(ch==='"') {
          quoted=true;raw='';
          kind=depth===1 && state==='key'?'key':depth===1 && state==='value' && key==='content' && !seen?'content':'other';
          if(kind==='content')seen=true;
        } else if(ch==='{' || ch==='[') depth++;
        else if(ch==='}' || ch===']'){depth--;if(depth===0){disabled=true;break;}if(depth===1)state='after';}
        else if(depth===1 && ch===':')state='value';
        else if(depth===1 && ch===','){state='key';key='';}
      }
      push(output);
    },
    end(){if(high){emit(high);high='';}},
  };
}
module.exports={contentStream};
