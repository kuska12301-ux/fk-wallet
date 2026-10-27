import {createHmac,createCipheriv,createDecipheriv,randomBytes,timingSafeEqual} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import https from 'node:https';
import {HttpError} from './auth.mjs';

export function encryptSecret(secret,key){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  return Buffer.concat([iv,cipher.update(secret,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');
}
export function decryptSecret(value,key){
  const raw=Buffer.from(value,'base64');const decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(-16));
  return Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]).toString('utf8');
}
export const signWebhook=(secret,timestamp,body)=>createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex');
export function verifyWebhook(secret,timestamp,body,signature,now=Math.floor(Date.now()/1000)){
  if(!/^\d{10}$/.test(timestamp||'')||Math.abs(now-Number(timestamp))>300||!/^sha256=[a-f0-9]{64}$/.test(signature||''))return false;
  return timingSafeEqual(Buffer.from(signature.slice(7),'hex'),Buffer.from(signWebhook(secret,timestamp,body),'hex'));
}
export function publicAddress(address){
  if(isIP(address)===4){
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===192&&b===0||a===192&&b===88&&c===99||a===198&&(b===18||b===19)||a===198&&b===51&&c===100||a===203&&b===0&&c===113);
  }
  if(isIP(address)===6){
    const [first,second]=address.toLowerCase().split(':').map(v=>parseInt(v||'0',16));
    return first>=0x2000&&first<=0x3fff&&first!==0x2002&&first!==0x3fff&&!(first===0x2001&&(second<=0x1ff||second===0xdb8));
  }
  return false;
}
export function webhookUrl(value){
  if(value===null||value==='')return null;
  if(typeof value!=='string'||value.length>2048)throw new HttpError(400,'Некорректный webhook URL.');
  let url;try{url=new URL(value);}catch{throw new HttpError(400,'Некорректный webhook URL.');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443')throw new HttpError(400,'Webhook: только HTTPS, порт 443, без пароля и #.');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(isIP(host)&&!publicAddress(host))throw new HttpError(400,'Webhook не может указывать на локальную или служебную сеть.');
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local'))throw new HttpError(400,'Локальный webhook запрещён.');
  return url.href;
}
async function addresses(host){
  let timer;try{return await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS timeout')),5000);timer.unref?.();})]);}finally{clearTimeout(timer);}
}
export async function validateWebhookTarget(value){
  const normal=webhookUrl(value);if(!normal)return null;
  const host=new URL(normal).hostname.replace(/^\[|\]$/g,'');
  let results;try{results=isIP(host)?[{address:host,family:isIP(host)}]:await addresses(host);}catch{throw new HttpError(400,'Не удалось разрешить адрес webhook.');}
  if(!results.length||results.some(row=>!publicAddress(row.address)))throw new HttpError(400,'Webhook должен разрешаться только в публичные IP-адреса.');
  return {url:normal,addresses:results};
}
export async function deliverWebhook(target,body,headers){
  // Re-resolve every delivery, validate every address, then pin this connection to the validated set.
  const checked=await validateWebhookTarget(target),url=new URL(checked.url);
  return await new Promise((resolve,reject)=>{
    const request=https.request(url,{method:'POST',agent:false,headers:{...headers,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},lookup:(hostname,options,callback)=>{
      const candidates=options.family?checked.addresses.filter(a=>a.family===options.family):checked.addresses;
      if(!candidates.length)return callback(new Error('No public address'));
      if(options.all)callback(null,candidates);else callback(null,candidates[0].address,candidates[0].family);
    }},response=>{
      let bytes=0;response.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536)request.destroy(new Error('Webhook response too large'));});
      response.on('end',()=>{if(response.statusCode>=200&&response.statusCode<300)resolve();else reject(new Error('HTTP '+response.statusCode));});
      response.on('error',reject);
    });
    const timer=setTimeout(()=>request.destroy(new Error('Webhook timeout')),8000);timer.unref?.();
    request.on('close',()=>clearTimeout(timer));request.on('error',reject);request.end(body);
  });
}
export class WebhookWorker {
  constructor(service,{deliver=deliverWebhook,clock=()=>Math.floor(Date.now()/1000)}={}){this.service=service;this.deliver=deliver;this.clock=clock;this.busy=false;this.closed=false;}
  start(){this.timer=setInterval(()=>this.tick().catch(()=>{}),2000);this.timer.unref?.();}
  stop(){this.closed=true;clearInterval(this.timer);return this.running||Promise.resolve();}
  tick(){if(this.closed||this.busy||!this.service.config.encryptionKey)return Promise.resolve();this.running=this.process();return this.running;}
  async process(){
    this.busy=true;
    try{
      for(let i=0;i<10&&!this.closed;i++){
        const job=this.service.claimJob(this.clock());if(!job)break;
        try{
          const secret=decryptSecret(job.webhook_secret,this.service.config.encryptionKey),timestamp=String(this.clock());
          await this.deliver(job.target_url,job.payload,{'FK-Event-Id':job.id,'FK-Timestamp':timestamp,'FK-Signature':'sha256='+signWebhook(secret,timestamp,job.payload)});
          this.service.finishJob(job.id,true,this.clock());
        }catch(error){this.service.finishJob(job.id,false,this.clock(),/^HTTP \d{3}$/.test(error.message)?error.message:'Ошибка доставки или недопустимый адрес');}
      }
    }finally{this.busy=false;}
  }
}
