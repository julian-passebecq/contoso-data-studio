import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1440,height:1000}});
await p.goto('http://127.0.0.1:5173',{waitUntil:'networkidle'});
await p.locator('.pageTitle').getByText('Projects',{exact:true}).waitFor();
const results={};
await p.locator('aside').getByRole('button',{name:'Projects',exact:true}).focus();
await p.keyboard.press('Tab');
results.keyboardFocus=await p.evaluate(()=>({tag:document.activeElement.tagName,text:document.activeElement.textContent}));
assert.notEqual(results.keyboardFocus.tag,'BODY');
for(const name of ['Transform','Canvas','Lakehouse','Query','Charts']){
  await p.locator('aside').getByRole('button',{name,exact:true}).click();
  if(name==='Transform') await p.getByText('70/70 passing',{exact:true}).waitFor();
  if(name==='Canvas'){
    await p.getByText('dbt manifest · 12 nodes · 9 dependencies',{exact:true}).waitFor();
    results.canvasScroll=await p.locator('.canvasBoard').evaluate(e=>{const before=e.scrollLeft;e.scrollLeft=10000;return {before,after:e.scrollLeft,width:e.clientWidth,scrollWidth:e.scrollWidth}});
    assert.ok(results.canvasScroll.after>0);
  }
  if(name==='Lakehouse') await p.locator('.tableItemButton').first().waitFor();
  if(name==='Charts') await p.locator('.kpiValue').first().waitFor();
  await p.screenshot({path:`../../evidence/browser/viewport-${name.toLowerCase()}.png`});
}
await writeFile('../../evidence/browser/visual-details.json',JSON.stringify(results,null,2));
await b.close();
console.log('VISUAL_DETAILS_PASS');
