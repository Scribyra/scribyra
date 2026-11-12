// Projection only: no test titles, paths, errors, attachments or browser content.
import {writeFile} from 'node:fs/promises';
export default class SafeReporter {
 onBegin(_config,suite){this.suite=suite;}
 async onEnd(){
  const counts={total:0,passed:0,failed:0,skipped:0,cancelled:0,todo:0,flaky:0};
  for(const test of this.suite.allTests()){
   counts.total++;const outcome=test.outcome();
   if(outcome==='expected'||outcome==='flaky'){counts.passed++;if(outcome==='flaky')counts.flaky++;}
   else if(outcome==='skipped')counts.skipped++;
   else if(test.results.at(-1)?.status==='interrupted')counts.cancelled++;
   else counts.failed++;
  }
  await writeFile(process.env.SCRIBYRA_RUN_SUMMARY_FILE,JSON.stringify(counts),{mode:0o600});
 }
}
