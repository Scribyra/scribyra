// Reporting stays in the person's own email: nothing here sends anything.
import {restoreDialogFocus} from './input.js';

export const PRIVACY_URL='https://scribyra.com/privacy.html',LICENSES_URL='https://scribyra.com/licenses.html';
const ADDRESS='contact@scribyra.com';
export function problemMail(){
 const version=typeof __SCRIBYRA_BUILD__==='undefined'?'':`${__SCRIBYRA_BUILD__.version} ${__SCRIBYRA_BUILD__.revision?.slice(0,12)||''}`.trim();
 const body=`What happened?\n\n\nWhat did you expect?\n\n\nBrowser and system:\nScribyra version: ${version}\n`;
 return `mailto:${ADDRESS}?subject=${encodeURIComponent('Scribyra problem report')}&body=${encodeURIComponent(body)}`;
}
export function reportDialog({openDiagnostics}){
 const dialog=document.createElement('dialog');dialog.className='modal report-dialog';dialog.setAttribute('aria-label','Report a problem');restoreDialogFocus(dialog);
 const text=(tag,value)=>{const node=document.createElement(tag);node.textContent=value;return node;};
 const close=()=>{dialog.close();dialog.remove();};
 const mail=text('a','Write email');mail.className='button primary';mail.href=problemMail();
 const diagnostics=text('button','Open Diagnostics');diagnostics.type='button';diagnostics.className='button secondary';diagnostics.onclick=()=>{close();openDiagnostics();};
 const done=text('button','Close');done.type='button';done.className='button secondary';done.onclick=close;
 const actions=document.createElement('div');actions.className='modal-actions';actions.append(done,diagnostics,mail);
 dialog.append(text('h2','Report a problem'),
  text('p',`Write to ${ADDRESS} from your own email and tell us what happened. Scribyra doesn’t send anything for you.`),
  text('p','A diagnostics file helps, and is optional. It holds the version, operation names, outcomes, error categories and timings. It has no paper text, file names, logs or credentials.'),
  text('p','Attaching your project is voluntary. We can usually help without it, so only send an exported ZIP if you’re happy for us to read it.'),
  actions);
 dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 document.body.append(dialog);dialog.showModal();
}
