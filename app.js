let timer;
function safe(s){return String(s||'').replace(/[<>]/g,'').trim()}
function status(state,badge){document.getElementById('state').textContent=state;document.getElementById('badge').textContent=badge}
function progress(v,msg){
  document.getElementById('bar').style.width=v+'%';
  document.getElementById('msg').textContent=msg;
  const parts=[document.getElementById('seg1'),document.getElementById('seg2'),document.getElementById('seg3'),document.getElementById('seg4')];
  parts.forEach((p,i)=>p.style.width = Math.max(0,Math.min(100,(v-i*25)*4))+'%');
}
function showError(msg){const e=document.getElementById('error');e.textContent=msg;e.style.display='block';status('Error','ERROR')}
async function generateVideo(){
 const btn=document.getElementById('generate');
 const idea=safe(document.getElementById('idea').value);
 const style=document.getElementById('style').value;
 const aspectRatio=document.getElementById('aspect').value;
 const wrap=document.getElementById('durationWrap');
 const durationSeconds=wrap.style.display==='none'?10:Number(document.getElementById('duration').value);

 if(!navigator.onLine){showError('Your browser is offline. Reconnect and try again.');return}
 if(!idea){showError('Enter an idea first.');document.getElementById('idea').focus();return}
 if(btn.disabled)return;

 btn.disabled=true;
 btn.textContent='Starting…';
 document.getElementById('videoWrap').style.display='none';
 document.getElementById('videoEmpty').style.display='flex';
 document.getElementById('videoOverlay').style.display='none';
 document.getElementById('error').style.display='none';
 document.getElementById('outputSpec').textContent=`${durationSeconds}s • ${wrap.style.display==='none'?'360p':'480p'}`;
 status('Checking account…','WORKING');
 progress(2,'Checking your account and video allowance…');

 try{
   const me=await fetch('/api/auth/me',{credentials:'include',cache:'no-store'});
   if(me.status===401){location.href='/account?next=generator';return}
   const meData=await me.json();
   if(!me.ok)throw new Error(meData.error||'Your account could not be verified.');

   const diag=await fetch('/api/generator-status',{credentials:'include',cache:'no-store'});
   const diagData=await diag.json();
   if(!diag.ok)throw new Error(diagData.error||'The generator is unavailable.');
   if(!diagData.ownerBypass && diagData.usage.remaining<=0){
      throw new Error(diagData.usage.period==='day'?'You have used your free video for today.':'You have used all of your videos for this month.');
   }

   status('Starting your Short…','WORKING');
   progress(5,`Starting ${durationSeconds}-second ${diagData.resolution} generation…`);

   const controller=new AbortController();
   const timeout=setTimeout(()=>controller.abort(),20000);
   let r;
   try{
     r=await fetch('/api/generate-video',{
       method:'POST',
       credentials:'include',
       cache:'no-store',
       headers:{'Content-Type':'application/json'},
       body:JSON.stringify({idea,style,aspectRatio,durationSeconds}),
       signal:controller.signal
     });
   }finally{clearTimeout(timeout)}

   let d={};
   try{d=await r.json()}catch{}
   if(!r.ok)throw new Error(d.error||`The generator returned HTTP ${r.status}.`);
   if(!d.jobId)throw new Error('The generator started without returning a video job ID.');
   poll(d.jobId);
 }catch(e){
   if(e.name==='AbortError')showError('The generator took too long to respond. Open Render Logs to check whether the AI job started.');
   else showError(e.message||'Could not start generation.');
   btn.disabled=false;
   btn.textContent=wrap.style.display==='none'?'Generate 10-second free Short ✨':'Generate AI Short ✨';
 }
}
async function loadCompletedVideo(jobId, d){
 const vid=document.getElementById('video');
 const videoUrl=d.videoUrl+'?t='+Date.now();
 const capUrl=d.captionsUrl+'?t='+Date.now();
 document.getElementById('download').href=videoUrl;
 document.getElementById('openVideo').href=videoUrl;
 document.getElementById('captions').href=capUrl;
 document.getElementById('videoWrap').style.display='flex';
 document.getElementById('videoEmpty').style.display='none';
 document.getElementById('videoOverlay').style.display='block';
 document.getElementById('outputSpec').textContent=`${d.durationSeconds||''}s • 480p`;
 status('Opening your Short…','LOADING');
 progress(98,'Opening your finished video…');
 let objectUrl=null;
 const showPlayer=()=>{
   vid.style.display='block';
   document.getElementById('videoEmpty').style.display='none';
   document.getElementById('videoOverlay').style.display='block';
   document.getElementById('videoWrap').style.display='flex';
   status('Ready to watch','DONE');
   progress(100,d.message||'Your Short is ready.');
 };
 vid.onloadedmetadata=showPlayer;
 vid.oncanplay=showPlayer;
 vid.onerror=async()=>{
   // Try fetching the protected file explicitly with the signed-in session.
   // This also gives us a useful error instead of leaving the placeholder up.
   try{
     const r=await fetch(d.videoUrl,{credentials:'include',cache:'no-store'});
     if(!r.ok) throw new Error(`Video server returned HTTP ${r.status}.`);
     const type=r.headers.get('content-type')||'';
     if(!type.includes('video/mp4')) throw new Error(`Video server returned ${type||'an unknown content type'} instead of video/mp4.`);
     const blob=await r.blob();
     objectUrl=URL.createObjectURL(blob);
     vid.src=objectUrl; vid.load();
     document.getElementById('openVideo').href=objectUrl;
     return;
   }catch(e){
     showError(`The AI finished the video, but the browser could not load it. ${e.message}`);
   }
 };
 // Set source and force a fresh load.
 vid.preload='metadata';
 vid.controls=true;
 vid.src=videoUrl;
 try{vid.load()}catch{}
 // Verify the server-side file shortly after completion. Do not wait for a full download.
 setTimeout(async()=>{
   if(vid.readyState===0 && !vid.error){
     try{
       const r=await fetch('/api/video-debug/'+encodeURIComponent(jobId),{credentials:'include',cache:'no-store'});
       const info=await r.json();
       if(!info.hasFinalPath) showError(info.fileError||'The generated MP4 is no longer available on this Render instance.');
     }catch{}
   }
 },2200);
}
async function poll(id){
 try{
  const r=await fetch('/api/video-status/'+encodeURIComponent(id),{credentials:'include',cache:'no-store'});
  const d=await r.json();
  if(d.status==='failed'||!r.ok) throw new Error(d.error||'Video generation failed.');
  progress(d.progress||0,d.message||'Generating…');
  status(d.status==='completed'?'Complete…':'Generating…',d.status==='completed'?'DONE':'WORKING');
  if(d.status==='completed'){await loadCompletedVideo(id,d);document.getElementById('generate').disabled=false;return}
  timer=setTimeout(()=>poll(id),1000);
 }catch(e){showError(e.message);const b=document.getElementById('generate');b.disabled=false;b.textContent=document.getElementById('durationWrap').style.display==='none'?'Generate 10-second free Short ✨':'Generate AI Short ✨'}
}
document.addEventListener('DOMContentLoaded',()=>{
  const generateBtn=document.getElementById('generate');
  if(generateBtn) generateBtn.addEventListener('click', generateVideo);
});

async function checkout(plan){try{const me=await fetch('/api/auth/me');if(!me.ok){location.href='/account?next='+encodeURIComponent(plan);return}const r=await fetch('/api/create-checkout-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan})});const d=await r.json();if(d.url)location.href=d.url;else alert(d.error||'Could not start checkout.')}catch(e){document.getElementById('compatNote').hidden=false;setTimeout(()=>document.getElementById('compatNote').hidden=true,7000);alert('Checkout could not be opened. Your browser or an extension may be blocking Stripe. Please allow Stripe Checkout for payments.')}}
async function loadPlan(){try{const r=await fetch('/api/auth/me');if(!r.ok)return;const d=await r.json();const paid=d.user.plan==='creator'||d.user.plan==='pro';const wrap=document.getElementById('durationWrap');if(paid){wrap.style.display='block';document.getElementById('generate').textContent='Generate AI Short ✨';document.getElementById('stageRes').textContent='480P';document.getElementById('msg').textContent=`${d.user.plan.toUpperCase()} plan: choose 5–30 seconds. ${d.usage.remaining} remaining this month.`}else{wrap.style.display='none';document.getElementById('stageRes').textContent='360P';document.getElementById('generate').textContent='Generate 10-second free Short ✨';document.getElementById('msg').textContent='Free preview: 10 seconds at 360p delivery.'}}catch{}}
document.addEventListener('DOMContentLoaded', loadPlan);
const videoEl=document.getElementById('video'); if(videoEl) videoEl.addEventListener('timeupdate',()=>{const v=videoEl;const t=Math.floor(v.currentTime||0);const mm=String(Math.floor(t/60)).padStart(2,'0'),ss=String(t%60).padStart(2,'0');document.getElementById('videoTime').textContent=`${mm}:${ss}`});