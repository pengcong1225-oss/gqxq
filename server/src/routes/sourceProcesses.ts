import {Router} from 'express';
import {ok} from '../http/respond';
import {getSourceProcesses} from '../services/sourceProcessService';
export const sourceProcessesRouter=Router();
sourceProcessesRouter.get('/complaints/:idOrNo/source-processes',async(req,res,next)=>{
 try{res.setHeader('Cache-Control','no-store');ok(res,await getSourceProcesses(String(req.params.idOrNo)));}catch(error){next(error);}
});
