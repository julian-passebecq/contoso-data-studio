import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const dir = '../../evidence/browser';
await mkdir(dir, { recursive:true });
const evidence = { consoleErrors:[], warnings:[], exceptions:[], failedRequests:[], httpErrors:[], timings:{}, checks:[], layout:[] };
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const pending = new Set();
page.on('request',r=>{if(r.url().includes('/api/')) pending.add(r);});
page.on('requestfinished',r=>pending.delete(r));
page.on('requestfailed',r=>pending.delete(r));
async function settle(){
  await page.waitForTimeout(250);
  const end=Date.now()+60000;
  while(pending.size && Date.now()<end) await page.waitForTimeout(100);
  assert.equal(pending.size,0,'API requests must complete before navigation or capture');
  await page.waitForTimeout(100);
}
page.on('console',m=>{if(m.type()==='error') evidence.consoleErrors.push(m.text()); if(m.type()==='warning') evidence.warnings.push(m.text());});
page.on('pageerror',e=>evidence.exceptions.push(e.message));
page.on('requestfailed',r=>evidence.failedRequests.push({url:r.url(),error:r.failure()}));
page.on('response',r=>{if(r.status()>=400) evidence.httpErrors.push({url:r.url(),status:r.status()});});
async function snap(name){
  await settle();
  await page.screenshot({path:`${dir}/${name}.png`,fullPage:true});
  evidence.layout.push({name,...await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,errors:[...document.querySelectorAll('.errorText')].map(e=>e.textContent)}))});
  evidence.checks.push(name); console.log(name);
}
async function nav(name){ await settle(); await page.locator('aside').getByRole('button',{name,exact:true}).click(); await page.locator('.pageTitle').getByText(name,{exact:true}).waitFor(); await settle(); }
async function table(){await page.locator('table tbody tr').first().waitFor({timeout:30000});}
try {
  await page.goto('http://127.0.0.1:5173',{waitUntil:'networkidle'});
  await page.locator('.pageTitle').getByText('Projects',{exact:true}).waitFor();
  let t=Date.now(); await page.getByRole('button',{name:'Open + prepare demo',exact:true}).first().click();
  await page.getByText('Retail Sales 101 is ready',{exact:false}).waitFor({timeout:180000});
  evidence.timings.prepareSeconds=(Date.now()-t)/1000; await snap('01-project-ready');
  await nav('Explore');
  t=Date.now(); await page.locator('.fileList button').filter({hasText:'sales.parquet'}).first().click();
  await page.locator('.inspectPane').getByText('Parquet · 10,000 rows',{exact:true}).waitFor(); await table();
  assert.match(await page.locator('.inspectPane').innerText(),/10,000 rows/);
  evidence.timings.exploreSeconds=(Date.now()-t)/1000;
  await page.locator('.tableScroller').evaluate(e=>{e.scrollLeft=300;e.scrollTop=150;});
  await snap('02-explore-data');
  for(const tab of ['Schema','Row groups','Metadata']) { await page.locator('.tabStrip').getByRole('button',{name:tab,exact:true}).click(); await table(); await snap('03-explore-'+tab.replaceAll(' ','-').toLowerCase()); }
  await nav('Lakehouse'); await page.locator('.layer').filter({hasText:'BRONZE'}).getByRole('button',{name:/^sales/}).click();
  await page.getByRole('button',{name:'Preview',exact:true}).first().click(); await table(); await snap('04-lakehouse-bronze');
  await page.locator('.layer').filter({hasText:'GOLD'}).getByRole('button',{name:/^monthly_sales/}).click();
  await page.getByRole('button',{name:'Preview',exact:true}).first().click(); await table(); await snap('05-lakehouse-gold');
  await nav('Transform'); await page.getByText('70/70 passing',{exact:true}).waitFor();
  await page.locator('.dagNode').filter({hasText:'monthly_sales'}).click();
  await page.locator('.modelFacts').waitFor(); await snap('06-transform-detail');
  await page.locator('.workbenchTabs').getByRole('button',{name:'Lineage',exact:true}).click(); await snap('07-transform-lineage');
  await nav('Query');
  const sql='select store_country as country, round(sum(revenue),2) revenue, round(sum(gross_margin),2) gross_margin, round(sum(gross_margin)/nullif(sum(revenue),0),4) margin_rate from contoso.gold.store_performance group by 1 order by revenue desc;';
  await page.locator('textarea').fill(sql); t=Date.now();
  const response=page.waitForResponse(r=>r.url().endsWith('/api/query')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Run',exact:true}).click();
  const result=await (await response).json(); assert.deepEqual(result.columns,['country','revenue','gross_margin','margin_rate']); assert.ok(result.rows.length);
  await table(); evidence.timings.querySeconds=(Date.now()-t)/1000; await snap('08-query-gold');
  await page.locator('textarea').fill('delete from contoso.gold.store_performance;');
  await page.getByRole('button',{name:'Run',exact:true}).click(); await page.locator('.errorText').waitFor();
  evidence.readOnlyMessage=await page.locator('.errorText').innerText(); await snap('09-query-mutation-rejected');
  await nav('Charts'); await page.locator('.barChart .bar').first().waitFor(); await page.locator('.boardChartSpec').first().waitFor();
  assert.ok(await page.locator('.kpiValue').count()); await snap('10-charts');
  if(await page.getByRole('button',{name:'Validate board',exact:true}).isEnabled()){
    await page.getByRole('button',{name:'Validate board',exact:true}).click();
    await page.getByText('Board validates successfully.',{exact:true}).waitFor({timeout:90000}); await snap('11-charts-validated');
  }
  await nav('Canvas'); await page.locator('.canvasNode').first().waitFor(); await snap('12-canvas');
  assert.ok(await page.locator('.canvasNode').count()>10,'Canvas must render loaded pipeline nodes');
  await nav('Projects'); await page.getByRole('button',{name:'View guide',exact:true}).first().click();
  await page.getByText('steps complete',{exact:true}).waitFor(); await snap('13-projects-persisted');
  await page.reload({waitUntil:'networkidle'}); await page.getByRole('button',{name:'View guide',exact:true}).first().click();
  await page.getByText('steps complete',{exact:true}).waitFor(); await snap('14-projects-reloaded');
  assert.equal(evidence.exceptions.length,0); assert.equal(evidence.failedRequests.length,0);
  evidence.result='PASS';
} catch(e){ evidence.result='FAIL'; evidence.failure=e.stack; await snap('failure'); console.error(e); process.exitCode=1; }
finally { await writeFile(`${dir}/results.json`,JSON.stringify(evidence,null,2)); await browser.close(); }
