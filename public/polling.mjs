// Automatic reads have a separate budget from user edits and explicit refreshes.
export class RefreshBudget{
  constructor({interval,cloud=()=>false,visible=()=>true,now=()=>Date.now()}){
    Object.assign(this,{interval,cloud,visible,now});
    this.lastActive=now();this.lastAttempt=-Infinity;this.blockedUntil=0;this.pending=null;
  }
  active(){return this.visible()&&(!this.cloud()||this.now()-this.lastActive<300000);}
  touch(){const wasIdle=!this.active();this.lastActive=this.now();return wasIdle;}
  attempted(){this.lastAttempt=this.now();}
  defer(ms){this.blockedUntil=Math.max(this.blockedUntil,this.now()+ms);}
  run(task,{reason='poll',manual=false}={}){
    if(this.pending)return this.pending;
    if(!manual){
      const elapsed=this.now()-this.lastAttempt;
      if(!this.active()||this.now()<this.blockedUntil)return Promise.resolve(false);
      const minimum=reason==='retry'?0:reason==='poll'?this.interval():60000;
      if(elapsed<minimum)return Promise.resolve(false);
    }
    this.attempted();
    this.pending=Promise.resolve().then(task).finally(()=>{this.pending=null;});
    return this.pending;
  }
}

export function watchRefresh(budget,refresh,{document:doc=document,window:win=window}={}){
  const activity=()=>{if(budget.touch())refresh('resume');};
  const focus=()=>{budget.touch();refresh('focus');};
  const visibility=()=>{if(!doc.hidden)focus();};
  const online=()=>refresh('online');
  const pagehide=event=>{if(!event.persisted)stop();};
  const pageshow=event=>{if(event.persisted)focus();};
  const events=['pointerdown','keydown','input','scroll'];
  for(const event of events)doc.addEventListener(event,activity,{passive:true,capture:true});
  win.addEventListener('focus',focus);win.addEventListener('online',online);doc.addEventListener('visibilitychange',visibility);win.addEventListener('pageshow',pageshow);
  const timer=setInterval(()=>refresh('poll'),15000);
  const stop=()=>{
    clearInterval(timer);
    for(const event of events)doc.removeEventListener(event,activity,{capture:true});
    win.removeEventListener('focus',focus);win.removeEventListener('online',online);doc.removeEventListener('visibilitychange',visibility);
    win.removeEventListener('pageshow',pageshow);win.removeEventListener('pagehide',pagehide);
  };
  // A BFCache navigation freezes this document and can restore it later.
  win.addEventListener('pagehide',pagehide);
  return stop;
}
