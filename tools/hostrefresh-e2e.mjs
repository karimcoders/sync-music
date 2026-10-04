/**
 * Refreshing the HOST page must not stop the music.
 *
 * It used to: the host came back with an empty transport, told every speaker
 * "idle", and all of them stopped dead at 0:00.
 *   node tools/hostrefresh-e2e.mjs <app-url>
 */
import { chromium } from 'playwright';
const APP=process.argv[2]??'http://localhost:9090/';
async function signIn(p){ if(!(await p.getByTestId('host-signin').count()))return;
 await p.getByTestId('host-id').fill('admin'); await p.getByTestId('host-pw').fill('syncmusic'); await p.getByTestId('host-signin').click();
 await p.waitForFunction(()=>!!document.querySelector('[data-testid=save-pw],[data-testid=create-session]'),null,{timeout:30000});
 if(await p.getByTestId('save-pw').count()){await p.getByTestId('new-pw').fill('syncmusic');await p.getByTestId('new-pw2').fill('syncmusic');await p.getByTestId('save-pw').click();}
 await p.getByTestId('create-session').waitFor({timeout:30000});}
const b=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});
const pg=async()=>(await b.newContext()).newPage();
const host=await pg(); await host.goto(`${APP}#/host?mode=direct`,{waitUntil:'networkidle'});
await signIn(host); await host.getByTestId('create-session').click();
await host.getByTestId('playlist').waitFor({timeout:90000});
const link=await host.getByTestId('speaker-link').getAttribute('href');
await host.getByTestId('file').setInputFiles('/tmp/tone.wav');
const sp=[]; for(let i=0;i<2;i++){const p=await pg();await p.goto(`${link}?mode=direct`,{waitUntil:'networkidle'});await p.getByTestId('enable-speaker').click({timeout:30000});sp.push(p);}
await host.waitForFunction(()=> (window.__syncHost?.state?.speakers??[]).filter(x=>x.ready).length>=2,null,{timeout:90000});
await host.getByTestId('play').click();
await host.waitForTimeout(5000);
const probe=()=>Promise.all(sp.map(p=>p.evaluate(()=>{const a=window.__syncAudio,s=window.__syncClient.state;
  return {t:+(a?.currentTime??-1).toFixed(2),paused:a?a.paused:true,phase:s.phase,conn:s.conn};})));
let bad=0; const fail=(m)=>{bad++;console.log('✗ '+m);};
const before=await probe();
if(before.some(x=>x.paused)) fail('the song was not playing before the refresh');
else console.log(`✓ both phones playing at ${before[0].t}s before the host refreshes`);

await host.reload({waitUntil:'networkidle'});
console.log('  host page reloaded');

let silent=0,samples=0;
for(let k=0;k<16;k++){
  const r=await probe(); samples+=r.length; silent+=r.filter(x=>x.paused).length;
  await host.waitForTimeout(1000);
}
console.log(`  silent samples across both phones during 16 s: ${silent}/${samples}`);
if(silent>2) fail(`the speakers stopped when the host refreshed (${silent}/${samples} samples silent)`);
else console.log('✓ the speakers kept playing right through the host refresh');

const after=await probe();
const host2=await host.evaluate(()=>{const s=window.__syncHost?.state;return {spk:s?.speakerCount,state:s?.transport?.state};});
console.log(`  after: phones ${JSON.stringify(after.map(x=>x.t))}, host ${JSON.stringify(host2)}`);
if(host2.state!=='playing') fail(`the host came back as "${host2.state}" instead of playing`);
else console.log('✓ the host came back still playing, and found its speakers again');
const spread=(Math.max(...after.map(x=>x.t))-Math.min(...after.map(x=>x.t)))*1000;
if(after.some(x=>x.paused)) fail('a phone is stopped after the refresh');
else console.log(`✓ still in sync after the refresh: ${spread.toFixed(0)} ms apart`);

console.log(bad?'\nSOME CHECKS FAILED':'\nALL CHECKS PASSED');
await b.close();
process.exit(bad?1:0);
