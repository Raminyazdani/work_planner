import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';

const SESSION_MS=8*60*60*1000, WINDOW_MS=15*60*1000, ATTEMPTS=10;
export const digest=value=>createHash('sha256').update(value).digest('hex');
export function createAuth(store,{accessKeyHash='',cloud=false,now=Date.now}={}){
  const required=cloud||!!accessKeyHash;
  if(required&&!/^[a-f0-9]{64}$/i.test(accessKeyHash))throw Error('Access key is not configured');
  const credentialVersion=digest(accessKeyHash.toLowerCase());
  const cookieName=cloud?'__Host-work_planner':'work_planner_session';
  const cookies=req=>Object.fromEntries(String(req.headers.cookie||'').split(';').map(s=>s.trim().split(/=(.*)/s).slice(0,2)).filter(x=>x.length===2));
  const token=req=>cookies(req)[cookieName]||'';
  const cookie=(value,seconds)=>`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${cloud?'; Secure':''}`;
  async function session(req){
    if(!required)return true;
    const t=token(req);if(!/^[\w-]{43}$/.test(t))return false;
    const {value}=await store.read('auth-sessions',{sessions:{}});
    const entry=value.sessions?.[digest(t)];return !!entry&&entry.credentialVersion===credentialVersion&&Number(entry.expires)>now();
  }
  async function login(req,key){
    if(!required)return {cookie:null};
    const ip=cloud?String(req.headers['x-real-ip']||req.socket?.remoteAddress||'unknown'):String(req.socket?.remoteAddress||'local');
    const bucket=digest(ip+accessKeyHash);
    let blocked=false;
    await store.update('auth-rate-limits',{buckets:{}},value=>{
      const buckets=Object.fromEntries(Object.entries(value.buckets||{}).filter(([,v])=>v.until>now()));
      const current=buckets[bucket]||{count:0,until:now()+WINDOW_MS};
      blocked=current.count>=ATTEMPTS||Object.keys(buckets).length>=2000;
      if(!blocked)buckets[bucket]={...current,count:current.count+1};
      return {buckets};
    });
    if(blocked)return {error:'تعداد تلاش‌ها زیاد است؛ ۱۵ دقیقه بعد دوباره امتحان کن.',status:429};
    const supplied=typeof key==='string'&&key.length>=32&&key.length<=512?digest(key):digest('invalid');
    if(!timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(accessKeyHash,'hex')))return {error:'کلید ورود معتبر نیست.',status:401};
    const t=randomBytes(32).toString('base64url'),expires=now()+SESSION_MS;
    await store.update('auth-sessions',{sessions:{}},value=>{
      const sessions=Object.fromEntries(Object.entries(value.sessions||{}).filter(([,s])=>s.expires>now()).sort((a,b)=>b[1].expires-a[1].expires).slice(0,19));
      sessions[digest(t)]={expires,credentialVersion};return {sessions};
    });
    await store.update('auth-rate-limits',{buckets:{}},value=>{const buckets={...value.buckets};delete buckets[bucket];return {buckets};});
    return {cookie:cookie(t,SESSION_MS/1000)};
  }
  async function logout(req){
    const t=token(req);
    if(required&&/^[\w-]{43}$/.test(t))await store.update('auth-sessions',{sessions:{}},value=>{const sessions={...value.sessions};delete sessions[digest(t)];return {sessions};});
    return cookie('',0);
  }
  return {required,session,login,logout};
}
