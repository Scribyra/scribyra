import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
export async function buildNativeIme(){
 if(process.platform!=='linux')throw new Error('The WPE native input-method adapter currently supports Linux.');
 const source=resolve('tests/native/wpe-ime.c'),output=resolve('.cache/native-ime/wpe-ime.so');
 await mkdir(resolve('.cache/native-ime'),{recursive:true});
 // pkg-config emits flags from the local development environment, not project data.
 const flags=execFileSync('pkg-config',['--cflags','--libs','gobject-2.0'],{encoding:'utf8'}).trim().split(/\s+/);
 execFileSync(process.env.CC||'cc',['-shared','-fPIC','-Wall','-Wextra','-Wno-unused-parameter',source,'-o',output,...flags,'-ldl'],{stdio:'inherit'});
 return output;
}
