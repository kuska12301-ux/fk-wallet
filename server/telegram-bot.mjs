const escapeHtml=value=>String(value||'').slice(0,80).replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));

export function welcomeMessage(message,appUrl,username=''){
  if(message?.chat?.type!=='private'||!Number.isSafeInteger(message.chat.id)||typeof message.text!=='string')return null;
  const match=/^\/(start|wallet|help)(?:@([A-Za-z0-9_]+))?(?:\s+.*)?$/.exec(message.text.trim());
  if(!match||(match[2]&&match[2].toLowerCase()!==username.toLowerCase()))return null;
  const name=escapeHtml(message.from?.first_name);
  return {chat_id:message.chat.id,parse_mode:'HTML',text:`Привет, <b>${name||'друг'}</b>!\n\nДобро пожаловать в <b>FK WALLET</b> — платёжный метод в Telegram.\n\nПополняй кошелёк, оплачивай покупки через FK Pay и выводи USDT в CryptoBot.`,reply_markup:{inline_keyboard:[[{text:'Открыть FK WALLET',web_app:{url:appUrl}}]]}};
}

export class TelegramBotService{
  constructor(store,config,api=fetch){this.store=store;this.config=config;this.api=api;this.stopped=false;this.loop=null;this.username='';this.appUrl=config.origin+'/mini-app';this.store.db.exec('CREATE TABLE IF NOT EXISTS telegram_cursor(id INTEGER PRIMARY KEY CHECK(id=1),next_update INTEGER NOT NULL) STRICT; INSERT OR IGNORE INTO telegram_cursor VALUES(1,0)');}
  async call(method,body={}){
    let response,data;try{response=await this.api(`https://api.telegram.org/bot${this.config.botToken}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(35000)});data=await response.json();}catch{throw new Error('Telegram временно недоступен');}
    if(!response.ok||data.ok!==true){const error=new Error('Telegram API отклонил запрос');error.code=data?.error_code||response.status;throw error;}return data.result;
  }
  start(){if(this.loop)return;this.loop=this.run().catch(error=>console.error('Telegram bot:',error.message));}
  async run(){
    const me=await this.call('getMe');this.username=me.username||'';
    await this.call('setMyCommands',{commands:[{command:'start',description:'Открыть FK Wallet'}]});
    await this.call('setChatMenuButton',{menu_button:{type:'web_app',text:'FK Wallet',web_app:{url:this.appUrl}}});
    console.log(`Telegram bot: @${this.username}, приветствие /start подключено`);
    while(!this.stopped){
      const offset=this.store.db.prepare('SELECT next_update FROM telegram_cursor WHERE id=1').get().next_update;
      try{
        const updates=await this.call('getUpdates',{offset,timeout:25,allowed_updates:['message']});
        for(const update of updates){
          const reply=welcomeMessage(update.message,this.appUrl,this.username);if(reply)try{await this.call('sendMessage',reply);}catch(error){if(![400,403].includes(error.code))throw error;}
          this.store.db.prepare('UPDATE telegram_cursor SET next_update=? WHERE id=1').run(update.update_id+1);
        }
      }catch(error){if(this.stopped)return;if([401,409].includes(error.code)){console.error('Telegram bot: проверьте токен и отсутствие второго polling-процесса');return;}await new Promise(resolve=>setTimeout(resolve,3000));}
    }
  }
  async stop(){this.stopped=true;await this.loop;}
}
