const { spawn } = require('node:child_process');
const { constants } = require('node:fs');
const { mkdtemp, mkdir, writeFile, readdir, lstat, realpath, open, rm } = require('node:fs/promises');
const { tmpdir, homedir } = require('node:os');
const path = require('node:path');
const { imageSize } = require('image-size');
const bridge = require('./bridge.ts');
const { ApiError } = require('./completions.cjs');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function validateImage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Expected a JSON object.');
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16000) throw new ApiError(400, 'prompt must contain 1–16000 characters.', 'prompt');
  if (body.model !== undefined && body.model !== 'agy-image') throw new ApiError(400, 'Use model agy-image. Agy selects the image backend.', 'model');
  if (body.n !== undefined && body.n !== 1) throw new ApiError(400, 'Only n=1 is supported.', 'n');
  if (body.response_format !== undefined && body.response_format !== 'b64_json') throw new ApiError(400, 'Only response_format=b64_json is supported.', 'response_format');
  for (const key of Object.keys(body)) if (!['prompt','model','n','response_format','user'].includes(key)) throw new ApiError(400, `${key} is not supported for image generation. Specify visual preferences in prompt; exact dimensions are not guaranteed.`, key);
  return { prompt: body.prompt };
}

// Collect only regular image files inside newly-created conversations emitted by
// this CLI process. Never trust a file path in the model's text response.
async function collectImage(brainRoot, ids, started, signal) {
  let root;
  try { root = await realpath(brainRoot); } catch { throw new ApiError(502, 'Agy completed without an image artifact.', null, 'image_not_generated'); }
  const candidates = [];
  for (const id of ids) {
    if (!uuid.test(id)) continue;
    const directory = path.join(root, id);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) continue;
      // The built-in generator writes to the conversation root or scratch.
      for (const folder of [directory, path.join(directory, 'scratch')]) {
        let entries;
        try { if ((await lstat(folder)).isSymbolicLink()) continue; entries = await readdir(folder, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (!entry.isFile() || !/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
          const file = path.join(folder, entry.name), info = await lstat(file);
          if (info.mtimeMs >= started - 1000) candidates.push({file,mtime:info.mtimeMs});
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // The last artifact is the final revision if Agy refined the initial image.
  candidates.sort((a,b)=>b.mtime-a.mtime);
  for (const {file} of candidates) {
    signal?.throwIfAborted();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 32) continue;
      if (info.size > MAX_IMAGE_BYTES) throw new ApiError(502, 'Generated image exceeds the 10 MiB limit.', null, 'image_too_large');
      const bytes = await handle.readFile();
      if (bytes.length > MAX_IMAGE_BYTES) throw new ApiError(502, 'Generated image exceeds the 10 MiB limit.', null, 'image_too_large');
      let dimensions;
      try { dimensions = imageSize(bytes); } catch { continue; }
      const formats = {jpg:['image/jpeg','jpg'],png:['image/png','png'],webp:['image/webp','webp']};
      const format = formats[dimensions.type];
      if (!format || !dimensions.width || !dimensions.height) continue;
      return { b64_json: bytes.toString('base64'), mime_type: format[0], file_name: `generated-image.${format[1]}`, width: dimensions.width, height: dimensions.height };
    } finally { await handle.close(); }
  }
  throw new ApiError(502, 'Agy completed without a valid image artifact. No image was returned.', null, 'image_not_generated');
}

async function runImage(input, options, signal) {
  signal?.throwIfAborted();
  const executable = await bridge.resolveExecutable(options.executable);
  signal?.throwIfAborted();
  const workspace = await mkdtemp(path.join(tmpdir(), 'agy-image-api-'));
  const brainRoot = options.brainRoot || path.join(homedir(), '.gemini/antigravity-cli/brain');
  const existing = new Set(await readdir(brainRoot).catch(e => { if (e.code === 'ENOENT') return []; throw e; }));
  const ids = new Set();
  const started = Date.now();
  try {
    const agents = path.join(workspace, '.agents/agents');
    await mkdir(agents, { recursive: true });
    await writeFile(path.join(agents, 'api-image.md'), `---\nname: api-image\ndescription: Image request runner\nmainAgent: true\nsubagent: false\ntools: [generate_image]\n---\nGenerate one actual image by calling generate_image once with the user's visual description. Return its image artifact path after the tool completes. Do not create code, SVG, or placeholders. Do not call unrelated tools.\n`, { mode: 0o600 });
    await new Promise((resolve, reject) => {
      const args = ['--agent=api-image','--input-format=stream-json','--output-format=stream-json','--disable-slash-commands',`--print-timeout=${options.timeoutMs || 240000}ms`];
      if (options.model) args.push(`--model=${options.model}`);
      const child = spawn(executable,args,{cwd:workspace,detached:process.platform !== 'win32',stdio:['pipe','pipe','pipe']});
      let pending='',diagnostics='',bytes=0,result,failure;
      const kill = () => { try { if(process.platform !== 'win32' && child.pid) process.kill(-child.pid,'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
      const fail = error => { failure ||= error; kill(); };
      const abort = () => fail(signal.reason || new Error('Image request aborted'));
      const timer = setTimeout(()=>fail(new ApiError(504,'Image generation timed out.',null,'timeout')),options.timeoutMs || 240000);
      signal?.addEventListener('abort',abort,{once:true}); if(signal?.aborted)abort();
      const addId = id => { if(typeof id === 'string' && uuid.test(id) && !existing.has(id)) ids.add(id); };
      const parse = line => {
        if(!line.trim() || failure)return;
        try {
          const event=JSON.parse(line);
          if(event.event==='init')addId(event.conversation_id);
          if(event.event==='step_update')for(const sub of event.step_update?.subagent_info?.subagents || [])addId(sub.conversation_id);
          if(event.event==='result') { if(result)throw Error('Multiple results');result=event.result; }
          if(event.event==='error' || event.error)diagnostics=(diagnostics+JSON.stringify(event)).slice(-32768);
        } catch { diagnostics=(diagnostics+line).slice(-32768);fail(new Error('Invalid Agy image output')); }
      };
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        bytes+=Buffer.byteLength(chunk);if(bytes>8*1024*1024)return fail(new Error('Agy image output limit exceeded'));
        pending+=chunk;let end;while((end=pending.indexOf('\n'))>=0){parse(pending.slice(0,end));pending=pending.slice(end+1);}
      });
      child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-32768);});
      child.stdin.on('error',error=>{if(error.code!=='EPIPE')fail(error);});
      child.on('error',fail);
      child.on('close',code=>{
        clearTimeout(timer);signal?.removeEventListener('abort',abort);parse(pending);
        if(failure || code!==0 || result?.status!=='SUCCESS')return reject(bridge.verificationError(diagnostics+'\n'+JSON.stringify(result?.error || '')) || failure || new Error('Agy image generation failed'));
        resolve();
      });
      // Prompts never enter shell arguments or server logs.
      child.stdin.end(JSON.stringify({event:'user',message:{content:input.prompt}})+'\n');
    });
    signal?.throwIfAborted();
    const image = await collectImage(brainRoot, ids, started, signal);
    return {created:Math.floor(Date.now()/1000),data:[image]};
  } finally {
    await rm(workspace,{recursive:true,force:true});
    // Only conversations created by this request are removed, including any
    // rejected/intermediate generated images. Account credentials are elsewhere.
    for(const id of ids) await rm(path.join(brainRoot,id),{recursive:true,force:true});
  }
}
module.exports = { validateImage, runImage, collectImage };
