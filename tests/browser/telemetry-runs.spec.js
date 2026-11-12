import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
test.use({trace:'off',screenshot:'off',video:'off'});
test('private test dashboard renders stored failure evidence with a working trace link',async({page})=>{
 const state=process.env.SCRIBYRA_TEST_STORAGE_STATE;
 test.skip(!state,'Requires the private Grafana stack and stored test-run readback evidence.');
 const evidence=JSON.parse(await readFile(state+'/test-runs-evidence.json','utf8'));
 const failed=evidence.runs.find(v=>v.outcome==='failure');expect(failed).toBeTruthy();
 const base=Number(process.env.SCRIBYRA_TEST_STORAGE_PORT_BASE||18789),grafana=`http://127.0.0.1:${base+9}`;
 const password=(await readFile(state+'/grafana-admin.password','utf8')).trim();
 await page.goto(grafana+'/login');await page.getByLabel(/email or username/i).fill('operator');await page.getByLabel(/^password$/i).fill(password);await page.getByRole('button',{name:/^log in$/i}).click();await expect(page).not.toHaveURL(/\/login/);
 await page.goto(grafana+'/d/scribyra-test-runs?var-source=synthetic&var-suite=fault_validation&var-browser=none');
 await expect(page.getByText('Failed suite processes',{exact:true})).toBeVisible();
 await expect(page.getByText('Safe run summaries and artifact IDs',{exact:true})).toBeVisible();
 await page.getByText('Safe run summaries and artifact IDs',{exact:true}).scrollIntoViewIfNeeded();
 // Grafana virtualizes log rows; click re-resolves a row detached while scrolling.
 const line=page.getByText(new RegExp('"runId":\\s*"'+failed.runId+'"')).first();await line.click();
 const trace=page.getByRole('link',{name:'Suite trace',exact:true});await expect(trace).toBeVisible();await expect(trace).toHaveAttribute('href',new RegExp(failed.runId));
 await trace.click();await expect(page.getByText('test_run',{exact:true}).first()).toBeVisible();
});
