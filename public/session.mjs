// Session cookies are HttpOnly; credentials never enter browser storage.
export async function sessionInfo(){
  const response=await fetch('/api/session',{cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw new Error('وضعیت ورود دریافت نشد. دوباره تلاش کن.');
  const value=await response.json();
  if(!value||typeof value.authenticated!=='boolean'||typeof value.authRequired!=='boolean'||!['local','cloud'].includes(value.mode))throw new Error('پاسخ برنامه معتبر نیست.');
  return value;
}
export async function login(accessKey){
  const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessKey}),cache:'no-store',credentials:'same-origin'});
  if(!response.ok){
    if(response.status===429)throw new Error('تلاش‌های ورود زیاد بوده؛ کمی بعد دوباره امتحان کن.');
    if(response.status===401||response.status===403)throw new Error('کلید دسترسی درست نیست.');
    throw new Error('ورود انجام نشد. اتصال و تنظیمات برنامه را بررسی کن.');
  }
  return sessionInfo();
}
