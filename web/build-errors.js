import {compilation_diagnostics} from './pkg/scribyra_app.js';
export function boundedText(value,characters){const text=String(value||'').slice(0,characters);return /[\uD800-\uDBFF]$/.test(text)?text.slice(0,-1):text;}
export class CompileTimeoutError extends Error {
 name='CompileTimeoutError';constructor(milliseconds,phase){super(`Compiler execution exceeded ${milliseconds/1000} seconds during ${phase}. Component preparation uses a separate idle timeout. Check for loops or simplify a long-running document. Project sources and the previous PDF are unchanged.`);this.milliseconds=milliseconds;this.phase=phase;}
}
export function buildFailure(error,{mainFile,projectFiles}={}){
 const message=boundedText(error.message||error,1000),failure=error.name==='CompileTimeoutError'?{kind:'timeout',milliseconds:error.milliseconds,phase:boundedText(error.phase,200)}:error.name==='TexPackageError'?{kind:'package-transfer',package:error.package,message}:error.name==='TexEnvironmentError'?{kind:'environment',message}:{kind:'runtime',message};
 return JSON.parse(compilation_diagnostics(JSON.stringify({failure,log:boundedText(error.texLog,2*1024*1024),mainFile,projectFiles})));
}
