import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, validateTelegram, digest } from './auth.mjs';
import { WalletStore } from './store.mjs';
import { MerchantService } from './merchant.mjs';
import { WebhookWorker } from './webhooks.mjs';

const staticRoot=fileURLToPath(new URL('../dist/',import.meta.url));
export function createWalletServer(config) {
  const store=new WalletStore(config.dbPath);
  const merchant=new MerchantService(store,config);
  const worker=new WebhookWorker(merchant);
  worker.start();
  const rate=new Map();
  const app=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org https://*.t.me; base-uri 'none'; form-action 'self'");
    if(config.secure) res.setHeader('Strict-Transport-Security','max-age=31536000');
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try {
      const url=new URL(req.url,config.origin);
      if(!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/v1/')) {
        if(!['GET','HEAD'].includes(req.method)) throw new HttpError(405,'Метод не поддерживается.');
        const relative=decodeURIComponent(['/', '/mini-app'].includes(url.pathname)?'/index.html':url.pathname);
        const file=resolve(staticRoot,'.'+relative);
        if(!file.startsWith(resolve(staticRoot)+sep) || !['.html','.js','.css','.svg','.png','.jpg','.ico'].includes(extname(file))) throw new HttpError(404,'Не найдено.');
        let content;try{content=await readFile(file);}catch{throw new HttpError(404,'Не найдено.');}
        const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
        res.writeHead(200,{'Content-Type':mime[extname(file)],'Cache-Control':'no-cache'});return res.end(req.method==='HEAD'?undefined:content);
      }
      // Forwarded headers are intentionally ignored: a caller cannot pick their rate-limit IP.
      const ip=req.socket.remoteAddress||'unknown'; const bucket=Math.floor(Date.now()/60000);
      const limitKey=(url.pathname==='/api/auth/telegram'?'login:':'api:')+ip;
      const previous=rate.get(limitKey);const hits=previous?.bucket===bucket?previous.hits+1:1;
      if(rate.size>10000) rate.delete(rate.keys().next().value);
      rate.set(limitKey,{bucket,hits});
      if(hits>(url.pathname==='/api/auth/telegram'?20:300)) {res.setHeader('Retry-After','60');throw new HttpError(429,'Слишком много запросов. Повторите через минуту.');}
      // Merchant API keys are server-to-server credentials, separate from Telegram sessions.
      if(url.pathname.startsWith('/v1/')){
        const client=merchant.authenticate(req.headers.authorization),match=/^\/v1\/invoices\/([a-f0-9-]{36})(\/cancel)?$/.exec(url.pathname);
        if(req.method==='GET'&&url.pathname==='/v1/balance')return send(200,{asset:'USDT',available:store.user(client.owner_id).balance,scope:'owner_wallet'});
        if(req.method==='POST'&&url.pathname==='/v1/invoices')return send(201,merchant.createInvoice(client,await readJson(req),req.headers['idempotency-key']));
        if(req.method==='GET'&&url.pathname==='/v1/invoices')return send(200,merchant.listInvoices(client.id,{before:cursor(url),status:url.searchParams.get('status')}));
        if(match&&req.method==='GET'&&!match[2])return send(200,merchant.invoice(merchant.findInvoice(match[1],client.id)));
        if(match&&req.method==='POST'&&match[2])return send(200,merchant.cancelInvoice(client,match[1]));
        throw new HttpError(404,'Метод FK Pay API не найден.');
      }
      const publicInvoice=/^\/api\/invoices\/([a-f0-9-]{36})$/.exec(url.pathname);
      if(req.method==='GET'&&publicInvoice)return send(200,merchant.invoice(merchant.findInvoice(publicInvoice[1]),false));
      const mutating=!['GET','HEAD'].includes(req.method);
      if(mutating && req.headers.origin!==config.origin) throw new HttpError(403,'Недопустимый источник запроса.');
      if(req.method==='POST' && url.pathname==='/api/auth/telegram') {
        const body=await readJson(req);
        const user=validateTelegram(body.initData,config.botToken,config.authMaxAge);
        store.register(user);
        const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
        store.createSession(digest(token),user.id,csrf,Math.floor(Date.now()/1000)+config.sessionTtl);
        res.setHeader('Set-Cookie',`fk_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionTtl}${config.secure?'; Secure':''}`);
        return send(200,{user:store.user(user.id),isAdmin:config.adminIds.has(user.id),csrf,sessionToken:token});
      }
      const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('fk_session='))?.slice(11);
      // Telegram Web may embed the Mini App with third-party cookies blocked.
      // The frontend keeps the bearer token only in memory, never in localStorage.
      const bearer=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1];
      const sessionToken=bearer||cookie;
      const session=sessionToken&&/^[a-f0-9]{64}$/.test(sessionToken)?store.session(digest(sessionToken)):null;
      if(!session) throw new HttpError(401,'Откройте Mini App через Telegram и войдите снова.');
      if(mutating) {
        const csrf=req.headers['x-csrf-token'];
        if(typeof csrf!=='string' || !/^[a-f0-9]{48}$/.test(csrf) || !timingSafeEqual(Buffer.from(csrf),Buffer.from(session.csrf))) throw new HttpError(403,'Недействительный CSRF-токен.');
      }
      const isAdmin=config.adminIds.has(session.user_id);
      if(url.pathname.startsWith('/api/admin/')&&!isAdmin) throw new HttpError(403,'Доступ только для администратора.');
      if(req.method==='GET'&&url.pathname==='/api/me') return send(200,{user:store.user(session.user_id),isAdmin,csrf:session.csrf});
      const payment=/^\/api\/invoices\/([a-f0-9-]{36})\/pay$/.exec(url.pathname);
      if(req.method==='POST'&&payment)return send(200,merchant.payInvoice(session.user_id,payment[1],await readJson(req),req.headers['idempotency-key']));
      if(req.method==='GET'&&url.pathname==='/api/developer/apps')return send(200,merchant.listApps(session.user_id));
      if(req.method==='POST'&&url.pathname==='/api/developer/apps')return send(201,await merchant.createApp(session.user_id,await readJson(req)));
      const developer=/^\/api\/developer\/apps\/([a-f0-9-]{36})(?:\/(rotate-key|revoke-key|invoices|events)(?:\/([a-f0-9-]{36})\/(retry|cancel))?)?$/.exec(url.pathname);
      if(developer){
        const [,id,action,item,verb]=developer;merchant.owned(session.user_id,id);
        if(req.method==='PATCH'&&!action)return send(200,await merchant.updateApp(session.user_id,id,await readJson(req)));
        if(req.method==='POST'&&action==='rotate-key')return send(200,merchant.rotateKey(session.user_id,id));
        if(req.method==='POST'&&action==='revoke-key')return send(200,merchant.revokeKey(session.user_id,id));
        if(req.method==='GET'&&action==='invoices'&&!item)return send(200,merchant.listInvoices(id,{before:cursor(url),status:url.searchParams.get('status')}));
        if(req.method==='POST'&&action==='invoices'&&!item)return send(201,merchant.createInvoice(merchant.owned(session.user_id,id),await readJson(req),req.headers['idempotency-key']));
        if(req.method==='POST'&&action==='invoices'&&item&&verb==='cancel')return send(200,merchant.cancelInvoice(merchant.owned(session.user_id,id),item));
        if(req.method==='GET'&&action==='events'&&!item)return send(200,merchant.events(session.user_id,id,cursor(url)));
        if(req.method==='POST'&&action==='events'&&item&&verb==='retry')return send(200,merchant.retryEvent(session.user_id,id,item));
      }
      if(req.method==='POST'&&url.pathname==='/api/logout') {
        store.deleteSession(digest(sessionToken));res.setHeader('Set-Cookie',`fk_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${config.secure?'; Secure':''}`);return send(200,{ok:true});
      }
      if(req.method==='GET'&&url.pathname==='/api/transactions') return send(200,store.entries({userId:session.user_id,before:cursor(url)}));
      if(req.method==='GET'&&url.pathname==='/api/admin/summary') return send(200,store.summary());
      if(req.method==='GET'&&url.pathname==='/api/admin/users') {
        const search=(url.searchParams.get('search')||'').trim().replace(/^@/,'');
        const before=url.searchParams.get('before');
        if(search.length>64 || (before&&!/^[1-9]\d{0,15}$/.test(before))) throw new HttpError(400,'Некорректный фильтр.');
        return send(200,store.users(search,before));
      }
      if(req.method==='GET'&&url.pathname==='/api/admin/operations') {
        const userId=url.searchParams.get('userId')||null,kind=url.searchParams.get('kind')||null;
        if((userId&&!/^[1-9]\d{0,15}$/.test(userId))||(kind&&!['admin_credit','admin_debit','invoice_credit','invoice_debit'].includes(kind))) throw new HttpError(400,'Некорректный фильтр операций.');
        return send(200,store.entries({userId,kind,before:cursor(url)}));
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/adjustments') return send(200,store.adjust(session.user_id,await readJson(req),req.headers['idempotency-key']));
      throw new HttpError(404,'Метод API не найден.');
    } catch(error) {
      const status=error instanceof HttpError?error.status:500;
      if(status===500) console.error('Request failed:',error.code||error.name);
      if(!res.headersSent) send(status,{error:status===500?'Ошибка сервера. Повторите позже.':error.message});else res.end();
    }
  });
  app.requestTimeout=15000;app.headersTimeout=10000;
  app.on('close',()=>worker.stop().finally(()=>store.close()));
  return {app,store,merchant,worker};
}
function cursor(url) {
  const raw=url.searchParams.get('before');
  if(raw===null) return Number.MAX_SAFE_INTEGER;
  if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<1) throw new HttpError(400,'Некорректный курсор.');
  return Number(raw);
}
async function readJson(req) {
  if(!(req.headers['content-type']||'').startsWith('application/json')) throw new HttpError(415,'Требуется application/json.');
  let size=0;const chunks=[];
  for await(const chunk of req) {size+=chunk.length;if(size>20000) throw new HttpError(413,'Слишком большой запрос.');chunks.push(chunk);}
  try{const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body)) throw new Error();return body;}catch{throw new HttpError(400,'Некорректный JSON.');}
}
