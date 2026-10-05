import { chromium } from "playwright";
import { mkdir,writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const base=process.env.QA_BASE_URL || "http://127.0.0.1:5173";
const dir=process.env.QA_EVIDENCE_DIR || "qa-artifacts/project-workbenches";
await mkdir(dir,{recursive:true});
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const result={checks:[],exceptions:[],httpErrors:[]};
let expectedFailure=false;
page.on('pageerror',e=>result.exceptions.push(e.message));
page.on('response',r=>{if(r.status()>=400 && !expectedFailure) result.httpErrors.push({url:r.url(),status:r.status()});});
const switcher=page.getByRole('combobox',{name:'Switch project',exact:true});
async function ready(){await page.locator('.workspaceProjectBar select:not([disabled])').waitFor({timeout:180000});}
async function nav(name){await ready();await page.locator('aside').getByRole('button',{name,exact:true}).click();await page.locator('.pageTitle').getByText(name,{exact:true}).waitFor();}
async function snap(name){await page.screenshot({path:`${dir}/${name}.png`,fullPage:true});result.checks.push(name);console.log(name);}
try{
  await page.goto(base,{waitUntil:'networkidle'});await ready();
  for(const scenario of ['retail-baseline','foil-sensitivity']){
    const foil=scenario.startsWith('foil-');
    await switcher.selectOption(scenario);await ready();
    await page.locator('.pageTitle').getByText('Charts',{exact:true}).waitFor();
    const state=await (await page.request.get(`${base}/api/workspace/project-state`)).json();
    assert.equal(state.active_scenario,scenario);assert.equal(state.ready,true);
    await nav('Query');
    assert.match(await page.locator('textarea').inputValue(),foil ? /contoso.gold.foil_sensitivity/ : /contoso.gold.store_performance/);
    await page.getByRole('button',{name:'Run',exact:true}).click();
    await page.locator('table tbody tr').first().waitFor();
    assert.equal(await page.locator('.errorText').count(),0);
    if(foil) await page.getByRole('button',{name:'AEP P50/P90',exact:true}).waitFor();
    await snap(`${scenario}-sql`);
    await nav('Explore');
    await page.locator('.inspectPane').getByText('Parquet · 10,000 rows',{exact:true}).waitFor();
    await page.getByText(state.active_run.files[foil ? 'foil_trials' : 'sales'].path,{exact:true}).first().waitFor();
    await snap(`${scenario}-active-parquet`);
    await nav('Lakehouse');
    await page.locator('.layer .selected').waitFor();
    assert.match(await page.locator('.layer .selected').innerText(),foil ? /foil_project_summary/ : /monthly_sales/);
    await snap(`${scenario}-lakehouse`);
    await nav('Transform');await page.locator('.dagNode').first().waitFor();
    assert.match(await page.locator('.dagNode').first().innerText(),foil ? /foil_/ : /customer|currency_exchange|product|sales|store/);
    await snap(`${scenario}-lineage`);
    await nav('Canvas');await page.getByText(foil ? 'foil_experiments' : 'stg_sales',{exact:true}).first().waitFor();
    await snap(`${scenario}-canvas`);
    await nav('Generate');
    assert.equal(await page.locator('.scenarioLibrary button.selected').count(),1);
    const activeLabel=await page.locator('.scenarioLibrary button.selected').innerText();
    assert.match(activeLabel,foil ? /FOIL/ : /Retail baseline/);
    await snap(`${scenario}-generator`);
    await nav('Projects');
    await page.locator('.projectCard').filter({hasText:foil ? 'FOIL · Sensitivity Lab' : 'Retail Sales 101'}).getByRole('button',{name:'View guide',exact:true}).click();
    assert.match(await page.locator('.guideProgress b').innerText(),/7\s*\/\s*7/);
    await snap(`${scenario}-7of7`);
  }
  await page.reload({waitUntil:'networkidle'});await ready();
  assert.equal(await switcher.inputValue(),'foil-sensitivity');
  assert.match(await page.locator('.guideProgress b').innerText(),/7\s*\/\s*7/);
  await page.getByRole('button',{name:'View group architecture ↓',exact:true}).click();
  await page.waitForTimeout(600);
  const bounds=await page.locator('#group-architecture').boundingBox();assert(bounds.y>=0 && bounds.y<900);
  await snap('macro-architecture');
  expectedFailure=true;
  await page.route('**/api/projects/foil-investment/open',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({detail:'Project quality checks failed (simulated browser verification).'})}));
  await switcher.selectOption('foil-investment');
  await page.getByRole('alert').getByText('Project quality checks failed',{exact:false}).waitFor();await ready();
  assert.equal(await switcher.inputValue(),'foil-sensitivity');
  await snap('activation-failure-visible');
  await page.unroute('**/api/projects/foil-investment/open');expectedFailure=false;
  // Retry through the actual API and recover to the user's FOIL workspace.
  await page.locator('.projectCard').filter({hasText:'FOIL · LCOE & Investment'}).getByRole('button',{name:'Open project',exact:true}).click();await ready();
  assert.equal(await switcher.inputValue(),'foil-investment');
  await switcher.selectOption('foil-sensitivity');await ready();
  await nav('Projects');await snap('final-home');
  assert.equal(result.exceptions.length,0);assert.equal(result.httpErrors.length,0);result.status='PASS';
}catch(e){result.status='FAIL';result.failure=e.stack;console.error(e);await snap('failure');process.exitCode=1;}
finally{await writeFile(`${dir}/workbench-results.json`,JSON.stringify(result,null,2));await browser.close();}
