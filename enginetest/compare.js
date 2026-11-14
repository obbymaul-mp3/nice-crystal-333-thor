const fs=require('fs'); const [,,a,b]=process.argv; const A=new Float32Array(fs.readFileSync(a).buffer.slice(0)), B=new Float32Array(fs.readFileSync(b).buffer.slice(0));
if (A.length!==B.length){ console.log('LENGTH DIFFERS',A.length,B.length); process.exit(1); }
let mx=0, at=-1, sa=0, sd=0, nan=0; for(let i=0;i<A.length;i++){ if(!Number.isFinite(B[i])) nan++; const d=Math.abs(A[i]-B[i]); if(d>mx){ mx=d; at=i; } sa+=A[i]*A[i]; sd+=d*d; }
const rms=Math.sqrt(sa/A.length), err=Math.sqrt(sd/A.length); console.log(`rms ${rms.toFixed(4)}  max diff ${mx.toExponential(2)} at ${(at/2/48000).toFixed(2)}s  error ${(20*Math.log10(err/rms+1e-12)).toFixed(1)} dB rel  nan ${nan}`);
process.exit(nan||rms<1e-4?1:0);
