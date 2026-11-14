// The same scenario through the web engine, for comparison.
const fs=require('fs'), {load}=require('../../tests/lib.js');
const A=load(['GrainEngine','GP','mulberry','demoBells']); const sr=48000;
const [,, script, samplePath, outPath]=process.argv;
if (script==='--sample'){ const d=A.demoBells(sr), n=Math.min(d.L.length, sr*6), b=new Float32Array(n*2); for(let i=0;i<n;i++){ b[2*i]=d.L[i]; b[2*i+1]=d.R[i]; } fs.writeFileSync(samplePath, Buffer.from(b.buffer)); process.exit(0); }
const raw=new Float32Array(fs.readFileSync(samplePath).buffer.slice(0)), N=raw.length/2, L=new Float32Array(N), R=new Float32Array(N); for(let i=0;i<N;i++){ L[i]=raw[2*i]; R[i]=raw[2*i+1]; }
let e=null, out=[], inPos=0, feed=false;
for (const line of fs.readFileSync(script,'utf8').split('\n')) { const t=line.trim().split(/\s+/), op=t[0]; if(!op||op[0]==='#') continue;
  if (op==='engine'){ e=new A.GrainEngine(sr,{offline:t[1]!=='0'}); e.rnd=A.mulberry(+t[2]); e.ensureRing(); }
  else if (op==='load') e.load(L,R,sr);
  else if (op==='set') e.p[A.GP[t[1]]]=+t[2];
  else if (op==='on') e.noteOn(+t[1],+t[2]); else if (op==='off') e.noteOff(+t[1]); else if (op==='alloff') e.cmd('alloff');
  else if (op==='clock') e.setClock(+t[1],+t[2]);
  else if (op==='keylock'){ e.keyLock=t[1]!=='0'; e.strictOct=t[2]!=='0'; }
  else if (op==='lfo'){ const n=+t[7], targets=[]; for(let k=0;k<n;k++) targets.push([A.GP[t[8+2*k]], +t[9+2*k]]); e.setLfo(+t[1],{shape:+t[2],rate:+t[3],sync:t[4]!=='0',div:+t[5],depth:+t[6],targets}); }
  else if (op==='live') e.cmd('live',+t[1]); else if (op==='grab') e.cmd('grab');
  else if (op==='feed') feed=t[1]!=='0';
  else if (op==='run'){ const n=+t[1]; for(let d=0;d<n;d+=128){ const m=Math.min(128,n-d), oL=new Float32Array(m), oR=new Float32Array(m); let iL=null,iR=null;
      if(feed){ iL=new Float32Array(m); iR=new Float32Array(m); for(let i=0;i<m;i++){ iL[i]=L[(inPos+i)%N]; iR[i]=R[(inPos+i)%N]; } inPos+=m; }
      e.process(oL,oR,m,iL,iR); for(let i=0;i<m;i++) out.push(oL[i],oR[i]); } } }
fs.writeFileSync(outPath, Buffer.from(Float32Array.from(out).buffer)); console.log(out.length/2+' frames');
