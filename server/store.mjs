import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError, digest } from './auth.mjs';

export function parseAmount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,6})(\.\d{1,6})?$/.test(value)) throw new HttpError(400, 'Сумма: число строкой, до 6 знаков после точки.');
  const [whole, fraction=''] = value.split('.');
  const amount = BigInt(whole)*1000000n + BigInt(fraction.padEnd(6,'0'));
  if (amount <= 0n || amount > 1000000000000n) throw new HttpError(400, 'Сумма должна быть больше 0 и не больше 1 000 000 USDT.');
  return Number(amount);
}
export function formatAmount(micro) {
  const value = BigInt(micro); const sign = value < 0 ? '-' : ''; const absolute = value < 0 ? -value : value;
  return `${sign}${absolute/1000000n}.${(absolute%1000000n).toString().padStart(6,'0')}`;
}
export class WalletStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive:true, mode:0o700 });
    this.db = new DatabaseSync(filename, { timeout:5000 });
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, first_name TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0 AND balance<=100000000000000), created_at TEXT NOT NULL, last_login TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(actor_id,request_key)) STRICT;
      CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES operations(id), user_id TEXT NOT NULL REFERENCES users(id), actor_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('admin_credit','admin_debit')), amount INTEGER NOT NULL CHECK(amount!=0), balance_after INTEGER NOT NULL CHECK(balance_after>=0), reason TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS entry_user ON entries(user_id,id DESC);
      CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT,'Ledger entries cannot be edited'); END;
      CREATE TRIGGER IF NOT EXISTS entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT,'Ledger entries cannot be deleted'); END;
      CREATE TRIGGER IF NOT EXISTS operations_no_update BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'Operations cannot be edited'); END;
      CREATE TRIGGER IF NOT EXISTS operations_no_delete BEFORE DELETE ON operations BEGIN SELECT RAISE(ABORT,'Operations cannot be deleted'); END;`);
  }
  transaction(action) { this.db.exec('BEGIN IMMEDIATE'); try { const value=action(); this.db.exec('COMMIT'); return value; } catch(error) { this.db.exec('ROLLBACK'); throw error; } }
  register(user) {
    return this.transaction(() => {
      const now=new Date().toISOString();
      if (user.username) this.db.prepare('UPDATE users SET username=NULL WHERE username=? AND id!=?').run(user.username,user.id);
      this.db.prepare('INSERT INTO users(id,username,first_name,created_at,last_login) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_login=excluded.last_login').run(user.id,user.username,user.firstName,now,now);
      return this.user(user.id);
    });
  }
  user(id) { const row=this.db.prepare('SELECT * FROM users WHERE id=?').get(id); return row ? this.publicUser(row) : null; }
  publicUser(row) { return {id:row.id,username:row.username,firstName:row.first_name,balance:formatAmount(row.balance),createdAt:row.created_at,lastLogin:row.last_login}; }
  createSession(hash,userId,csrf,expires) { this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Math.floor(Date.now()/1000)); this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash,userId,csrf,expires); }
  session(hash) { return this.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires>?').get(hash,Math.floor(Date.now()/1000)); }
  deleteSession(hash) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash); }
  users(search='',before=null) {
    const rows=this.db.prepare("SELECT * FROM users WHERE (?='' OR id=? OR username LIKE ? ESCAPE '\\') AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT 51").all(search,search,`%${search.replace(/[\\%_]/g,'\\$&')}%`,before,before);
    return {items:rows.slice(0,50).map(row=>this.publicUser(row)),next:rows.length>50?rows[49].id:null};
  }
  entries({userId=null,before=Number.MAX_SAFE_INTEGER,kind=null}={}) {
    const rows=this.db.prepare('SELECT e.*,u.username,u.first_name FROM entries e JOIN users u ON u.id=e.user_id WHERE (? IS NULL OR e.user_id=?) AND e.id<? AND (? IS NULL OR e.kind=?) ORDER BY e.id DESC LIMIT 51').all(userId,userId,before,kind,kind);
    return {items:rows.slice(0,50).map(row=>({id:row.id,operationId:row.operation_id,userId:row.user_id,username:row.username,actorId:row.actor_id,kind:row.kind,amount:formatAmount(row.amount),balanceAfter:formatAmount(row.balance_after),reason:row.reason,createdAt:row.created_at})),next:rows.length>50?rows[49].id:null};
  }
  summary() {
    const row=this.db.prepare('SELECT count(*) AS users, CAST(COALESCE(sum(balance),0) AS TEXT) AS total FROM users').get();
    return {users:row.users,totalBalance:formatAmount(row.total),operations:this.db.prepare('SELECT count(*) AS n FROM operations').get().n};
  }
  adjust(actorId, body, key) {
    const amount=parseAmount(body.amount);
    if (!['credit','debit'].includes(body.direction)) throw new HttpError(400,'Выберите начисление или снятие.');
    if (typeof body.userId!=='string' || !/^[1-9]\d{0,15}$/.test(body.userId)) throw new HttpError(400,'Укажите Telegram ID пользователя.');
    const reason=typeof body.reason==='string'?body.reason.trim():'';
    if (reason.length<3 || reason.length>500) throw new HttpError(400,'Причина обязательна: 3–500 символов.');
    if (!/^[a-f0-9-]{36}$/i.test(key || '')) throw new HttpError(400,'Требуется UUID в Idempotency-Key.');
    const requestHash=digest(JSON.stringify([body.userId,body.direction,amount,reason]));
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT * FROM operations WHERE actor_id=? AND request_key=?').get(actorId,key);
      if(previous) {
        if(previous.request_hash!==requestHash) throw new HttpError(409,'Этот ключ уже использован для другой операции.');
        return {operationId:previous.id,replayed:true};
      }
      const target=this.db.prepare('SELECT * FROM users WHERE id=?').get(body.userId);
      if(!target) throw new HttpError(404,'Пользователь не найден. Он должен сначала открыть Mini App через Telegram.');
      const delta=body.direction==='credit'?amount:-amount;
      const balance=target.balance+delta;
      if(balance<0) throw new HttpError(409,'Недостаточно средств для снятия.');
      if(balance>100000000000000) throw new HttpError(409,'Превышен максимальный баланс счёта.');
      const id=randomUUID(),now=new Date().toISOString();
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(id,actorId,key,requestHash,now);
      this.db.prepare('UPDATE users SET balance=? WHERE id=?').run(balance,body.userId);
      this.db.prepare('INSERT INTO entries(operation_id,user_id,actor_id,kind,amount,balance_after,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,body.userId,actorId,'admin_'+body.direction,delta,balance,reason,now);
      return {operationId:id,balance:formatAmount(balance),replayed:false};
    });
  }
  close() { this.db.close(); }
}
