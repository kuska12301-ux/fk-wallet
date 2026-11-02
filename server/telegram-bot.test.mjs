import test from 'node:test';
import assert from 'node:assert/strict';
import {welcomeMessage} from './telegram-bot.mjs';

test('Telegram /start greeting escapes the name and opens the FK Wallet mini app',()=>{
  const reply=welcomeMessage({chat:{id:123,type:'private'},from:{first_name:'Аня <3'},text:'/start'},'https://wallet.example/mini-app','FK_WALLET_BOT');
  assert.match(reply.text,/Привет, <b>Аня &lt;3<\/b>!/);assert.match(reply.text,/FK WALLET/);
  assert.equal(reply.reply_markup.inline_keyboard[0][0].web_app.url,'https://wallet.example/mini-app');
  assert.equal(welcomeMessage({chat:{id:-1,type:'group'},text:'/start'},'https://wallet.example/mini-app'),null);
});
