import { readConfig } from './auth.mjs';
try {
  const config=readConfig();
  if(!config.secure) throw new Error('Для кнопки Mini App требуется PUBLIC_URL с HTTPS.');
  let result;
  try {
    const response=await fetch(`https://api.telegram.org/bot${config.botToken}/setChatMenuButton`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({menu_button:{type:'web_app',text:'FK Wallet',web_app:{url:config.origin}}}),signal:AbortSignal.timeout(15000)});
    result=await response.json();
  } catch { throw new Error('Telegram API недоступен. Проверьте сеть и повторите команду.'); }
  if(!result.ok) throw new Error('Telegram отклонил настройку кнопки. Проверьте BOT_TOKEN и PUBLIC_URL.');
  console.log('Кнопка «FK Wallet» настроена. Откройте личный чат с вашим ботом.');
} catch(error) { console.error(error.message); process.exitCode=1; }
