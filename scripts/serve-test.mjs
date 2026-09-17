import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
const root=resolve('dist');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.gz':'application/gzip'};
createServer(async(req,res)=>{
 try{
  const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(!path.startsWith('/DobakSimulator/')){res.writeHead(404);res.end();return;}
  const target=resolve(root,path.slice('/DobakSimulator/'.length)||'index.html');
  if(!target.startsWith(root+sep)){res.writeHead(403);res.end();return;}
  if(!(await stat(target)).isFile())throw Error('Not a file');
  res.writeHead(200,{'content-type':types[extname(target)]??'application/octet-stream'});res.end(await readFile(target));
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(4173,'127.0.0.1',()=>console.log('Build served at http://127.0.0.1:4173/DobakSimulator/'));
