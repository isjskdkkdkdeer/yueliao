import http from 'node:http';
import worker from '../dist/server/index.js';
const portArg=process.argv.indexOf('--port');
const port=Number(process.env.PORT||(portArg>=0?process.argv[portArg+1]:5173));
http.createServer(async(req,res)=>{
  try {
    const response=await worker.fetch(new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers}),{});
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Preview error')}
}).listen(port,'0.0.0.0',()=>console.log(`Preview listening on ${port}`));
