import {sessionInfo,login} from './session.mjs';
const form=document.getElementById('login-form'),key=document.getElementById('access-key'),button=document.getElementById('login-submit'),message=document.getElementById('login-message');
form.addEventListener('submit',async event=>{
  event.preventDefault();button.disabled=true;message.textContent='در حال ورود…';
  try{const session=await login(key.value);key.value='';if(!session.authenticated)throw Error('ورود تأیید نشد.');window.location.replace('/');}
  catch(error){message.textContent=error.message;key.value='';key.focus();}
  finally{button.disabled=false;}
});
try{if((await sessionInfo()).authenticated)window.location.replace('/');}catch(error){message.textContent=error.message;}
