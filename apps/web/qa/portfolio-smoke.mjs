import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const baseURL=process.env.QA_BASE_URL || "http://127.0.0.1:5173";
const evidence=process.env.QA_EVIDENCE_DIR || "qa-artifacts/portfolio";
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1050}});
const result={checks:[],exceptions:[],consoleErrors:[],httpErrors:[]};
const runIds={};
page.on("pageerror",e=>result.exceptions.push(e.message));
page.on("console",m=>{if(m.type()==="error")result.consoleErrors.push(m.text());});
page.on("response",r=>{if(r.status()>=400)result.httpErrors.push({url:r.url(),status:r.status()});});
async function snap(name){await page.screenshot({path:`${evidence}/${name}.png`,fullPage:true});result.checks.push(name);console.log(name);}
async function home(){await page.getByRole('button',{name:'Portfolio & architecture',exact:true}).click();await page.locator('.groupSwitcher').waitFor();}
async function checkActive(scenario){
  await page.locator('.projectOpening').waitFor({state:'hidden',timeout:180000});
  await page.locator('.pageTitle').getByText('Charts',{exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Switch project',exact:true}).inputValue(),scenario);
  const state=await (await page.request.get(`${baseURL}/api/workspace/project-state`)).json();
  assert.equal(state.active_scenario,scenario);assert.equal(state.ready,true);assert.deepEqual(state.gold_scenarios,[scenario]);
  const quality=await (await page.request.get(`${baseURL}/api/dbt/quality`)).json();
  assert.equal(quality.summary.fail+quality.summary.error,0);
  if(runIds[scenario])assert.equal(state.active_run.run_id,runIds[scenario]);else runIds[scenario]=state.active_run.run_id;
  if(scenario.startsWith('foil-')){await page.locator('.foilEnergyRow').first().waitFor();assert.equal(await page.locator('.foilEnergyRow').count(),9);}
  else {const label={'retail-baseline':'Revenue','online-migration':'Online share · 2024','margin-pressure':'Gross margin · 2024','logistics-delays':'Online avg delivery','currency-exposure':'Most volatile'}[scenario];await page.getByText(label,{exact:true}).first().waitFor();}
  await snap(`active-${scenario}`);
}
try{
  await page.goto(baseURL,{waitUntil:'networkidle'});
  await page.locator('.groupSwitcher').waitFor();
  await page.getByRole('combobox',{name:'Switch project',exact:true}).waitFor();
  await page.locator('.workspaceProjectBar select:not([disabled])').waitFor();
  assert.equal(await page.locator('.projectCard').count(),3);
  assert.equal(await page.locator('.portfolioStage').count(),5);
  await snap('01-foil-home');
  const initialActive=await page.getByRole('combobox',{name:'Switch project',exact:true}).inputValue();
  await page.locator('.groupTile').filter({hasText:'Samples'}).click();
  assert.equal(await page.locator('.projectCard').count(),5);
  assert.equal(await page.getByRole('combobox',{name:'Switch project',exact:true}).inputValue(),initialActive);
  await snap('02-samples-home');
  await page.locator('.groupTile').filter({hasText:'FOIL'}).click();
  await page.locator('.projectCard').filter({hasText:'FOIL · AEP & P50/P90'}).getByRole('button',{name:/^Open (project|dashboard)$/}).click();
  await page.locator('.projectOpening').waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Switch project',exact:true}).isDisabled(),true);
  assert.equal(await page.locator('aside button:not([disabled])').count(),0);
  // State requests during activation must wait for the writer, without SQLite errors.
  const concurrentState=page.request.get(`${baseURL}/api/workspace/project-state`);
  await checkActive('foil-energy-risk');
  assert.equal((await concurrentState).status(),200);
  for(const scenario of ['foil-investment','foil-sensitivity','retail-baseline','online-migration','margin-pressure','logistics-delays','currency-exposure','foil-energy-risk','foil-sensitivity']){
    await page.getByRole('combobox',{name:'Switch project',exact:true}).selectOption(scenario);
    await checkActive(scenario);
  }
  await home();
  assert.equal(await page.locator('.projectCard').count(),3);
  await page.reload({waitUntil:'networkidle'});
  await page.locator('.groupSwitcher').waitFor();
  await page.locator('.workspaceProjectBar select:not([disabled])').waitFor();
  assert.equal(await page.locator('.projectCard').count(),3);
  assert.equal(await page.getByRole('combobox',{name:'Switch project',exact:true}).inputValue(),'foil-sensitivity');
  await page.locator('.projectCard').filter({hasText:'FOIL · Sensitivity Lab'}).getByRole('button',{name:'View guide',exact:true}).click();
  // A guide action must reactivate its project before navigating to its workbench.
  await page.getByRole('button',{name:'Open Query',exact:true}).click();
  await page.locator('.pageTitle').getByText('Query',{exact:true}).waitFor({timeout:180000});
  assert.match(await page.locator('textarea').inputValue(),/foil_sensitivity/);
  await home();
  await page.setViewportSize({width:1100,height:900});
  await snap('03-compact-home');
  await page.setViewportSize({width:1440,height:1050});
  await snap('04-final-foil-home');
  assert.equal(result.exceptions.length,0);assert.equal(result.httpErrors.length,0);
  assert.equal(result.consoleErrors.filter(e=>!e.includes('Keyborg')).length,0);
  result.status='PASS';result.runIds=runIds;
}catch(error){result.status='FAIL';result.failure=error.stack;console.error(error);await snap('failure');process.exitCode=1;}
finally{await writeFile(`${evidence}/results.json`,JSON.stringify(result,null,2));await browser.close();}
