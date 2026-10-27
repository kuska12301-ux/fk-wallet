import { readConfig } from './auth.mjs';
import { createWalletServer } from './app.mjs';
try {
  const config=readConfig();
  const {app}=createWalletServer(config);
  app.listen(config.port,config.host,()=>console.log(`FK Wallet: ${config.origin} (listen ${config.host}:${config.port})`));
  app.on('error',error=>{console.error('Не удалось запустить сервер:',error.code);process.exitCode=1;app.close();});
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>app.close(()=>process.exit(0)));
}catch(error){console.error(error.message);process.exitCode=1;}
