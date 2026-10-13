// Run from any directory: node docs/mobile/browser-check.mjs [baseline|matrix|interactive]
// UI acceptance uses isolated browser storage and sample API responses. No real writes.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../app/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const outDir = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] || 'matrix';
const garment = (color) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="300" viewBox="0 0 240 300"><rect width="240" height="300" fill="#f3f1ea"/><path d="M78 38 103 48 120 69 137 48 162 38 211 91 185 155 166 131 178 264 62 264 74 131 55 155 29 91Z" fill="${color}"/><path d="M103 48 120 69 137 48M120 69V263M80 175H106M134 175H160" fill="none" stroke="#72644f" stroke-width="2"/><circle cx="126" cy="134" r="2" fill="#72644f"/><circle cx="126" cy="158" r="2" fill="#72644f"/><circle cx="126" cy="182" r="2" fill="#72644f"/></svg>`);
const ids = ['me14dw030', 'me14dw041', 'me14df046', '9aw2315052', 'me01dw020', '9aw210553', '9ss230517', 'me23df001', 'md09dc045', 'md15ff025'];
const names = ['羊毛混纺大衣', '经典廓形大衣', '双面呢长款外套', '秋季休闲西装外套', '通勤西装', '经典直筒牛仔裤', '高腰牛仔裤', '休闲阔腿裤', '柔软针织开衫', '短款夹克'];
const products = ids.map((id, i) => ({id, name:names[i], sub:'秋冬精选', img:garment(['#b6a78e','#545348','#837362'][i%3]), imgSource:'BI', colors:['黑色','咖色'], price:String(599+i*100), priceNum:599+i*100, mprice:String(499+i*100), stock:['黑色 126 件','咖色 98 件'], stockMain:224+i*10, inTransit:36, restock:'黑色 200 件 / 15天', fabric:'羊毛混纺', plannedQty:200, orderedQty:100, category:i<3?'大衣':i<5?'西装':i<8?'裤装':'针织', tempBand:'0~12°C', priceBand:'中', roles:i%2?['引流']:['利润'], conversion:0.082, returnRate:0.155, newBuyer:0.42, netSales:52000, ai:null, wave:'10A', sizeRange:'S~XL', bomCost:'260', season:'秋', material:'羊毛', tagValid:'有效', tagGreenLight:'是'}));
const section = (id, label, codes) => ({id, label, visible:true, looks:codes.map((pid,i)=>({id:`${id}-L${i}`,pids:[pid],cover:pid}))});
const sampleTrays = [
  {id:'t1',name:'马总场',date:'2026-10-15',type:'马总直播货盘',template:'mazong',sections:[section('s1','主推A',ids.slice(0,3)),section('s2','主推B',ids.slice(3,5)),section('s3','现货',ids.slice(5,8))],viewPerm:['马总','商品','运营','主播团队'],editPerm:['商品','运营'],createdAt:'2026-10-01',updatedAt:'2026-10-13T06:00:00Z'},
  {id:'t2',name:'店播日常场',date:'2026-10-16',type:'店播直播货盘',template:'normal',sections:[section('s4','引流区',ids.slice(5,8))],viewPerm:['商品','运营','主播团队'],editPerm:['运营'],createdAt:'2026-10-01',updatedAt:'2026-10-13T06:00:00Z'},
  {id:'t3',name:'达人 · 王祖儿专场',date:'2026-10-18',type:'达人货盘',template:'talent',sections:[section('s5','主播热卖',ids.slice(8,10))],viewPerm:['商品','运营','达人商务'],editPerm:['达人商务'],createdAt:'2026-10-01',updatedAt:'2026-10-13T06:00:00Z'}
];
sampleTrays[0].sections[0].looks[0].pids.push(ids[8]);
const profile = {ages:[8,25,29,20,13,5],female:86,crowds:[8,12,24,17,9,8,12,10],stages:[5,25,28,42],provinces:[{name:'浙江',value:22},{name:'江苏',value:19},{name:'广东',value:16}],interests:[{name:'女装',value:62},{name:'美妆',value:38},{name:'时尚搭配',value:44},{name:'旅行',value:24}],customerType:[{name:'新客户',value:42},{name:'老客户',value:58}],payers:15680,store:'Marius旗舰店',platform:'淘宝',month:'2026-09'};
const cities = ['杭州','上海','北京','广州'].map((name,j)=>{
  const forecast = Array.from({length:16},(_,i)=>({date:`2026-10-${String(13+i).padStart(2,'0')}`,week:['周二','周三','周四','周五','周六','周日','周一'][i%7],tempMax:24-Math.floor(i/3)+j,tempMin:16-Math.floor(i/4)+j,weather:i%3?'晴':'小雨',precip:i%3?10:65,humidity:60+i%5,windScale:'3级',uvIndex:'中等',sunrise:'06:10',sunset:'17:45'}));
  return {name,forecast,trends:{avgTempMax:22,avgTempMin:15,avgTemp:18.6+j,tempTrend:'falling',tempTrendDesc:'持续降温',rainDays:3,weatherTypes:{晴:10,小雨:6},avgHumidity:64,hottestDay:forecast[0],coldestDay:forecast[15]}};
});
const ruleFixtures = {};
for(const key of ['role-rules','scene-rules','strategy-rules','weather-rules']){
  const res = await fetch(`http://localhost:3737/api/config/${key}`);
  if(!res.ok) throw new Error(`Cannot read existing ${key}: ${res.status}`);
  ruleFixtures[key] = await res.json();
}
const browser = await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const failures = [];
const reports = [];
const errors = [];
const apiWrites = [];
const interactions = [];
let currentPage;
const qaHtml = fileURLToPath(new URL('../../app/__mobile-ui-qa.html',import.meta.url));
const qaModule = fileURLToPath(new URL('../../app/src/__mobile-ui-qa.tsx',import.meta.url));
let qaCreated = false;
function check(name,result){interactions.push({name,passed:Boolean(result)});if(!result)failures.push(name);}
async function setup(width,scenario='default'){
  const context = await browser.newContext({viewport:{width,height:844},deviceScaleFactor:1,hasTouch:width<768,isMobile:width<768});
  let trays = scenario==='default'?structuredClone(sampleTrays):[];
  context.on('page', p=>p.on('pageerror', e=>errors.push({width,message:e.message})));
  await context.route('**/api/**',async route=>{
    const req=route.request(), u=new URL(req.url()), p=u.pathname.replace('/api','');
    let data={};
    if(req.method()!=='GET'){
      apiWrites.push({width,path:p,method:req.method()});
      const body=req.postDataJSON();
      if(p==='/trays'){trays=body.trays;data={ok:true};}
      else if(p.startsWith('/config/'))data={rules:body.rules};
      else data={ok:true,items:[],message:'验收模拟响应'};
    } else if(p==='/products'){
      if(scenario==='error'){await route.fulfill({status:503,contentType:'application/json',body:'{"error":"验收错误状态"}'});return;}
      data={items:scenario==='empty'?[]:products,source:'ui-acceptance-fixture',updatedAt:new Date().toISOString()};
    }
    else if(p==='/products/meta/filters')data={categories:['大衣','西装','裤装','针织'],waves:['10A'],tempBands:['0~12°C'],priceBands:['低','中','高'],roles:['引流','利润','库存'],launchYears:[2026]};
    else if(p==='/trays')data={trays,updatedAt:Date.now()};
    else if(p==='/trays/log')data={entries:[{id:'log1',user:'商品组',action:'修改价格',detail:'马总场',change:'599 → 699',at:Date.now()}]};
    else if(p.startsWith('/config/'))data=ruleFixtures[p.split('/').at(-1)];
    else if(p==='/weather')data={cities,failed:[],updateTime:new Date().toISOString(),cachedSecondsAgo:0};
    else if(p==='/profiles/sku-codes')data={codes:ids};
    else if(p.startsWith('/profiles/sku/'))data={profile,availablePlatforms:['淘宝','抖音']};
    else if(p==='/profiles/stores')data={stores:[{store:profile.store,month:'2026-09',months:[202609,202608]}]};
    else if(p.startsWith('/profiles/store/'))data={profile};
    else if(p==='/profiles/anchors')data={anchors:[{name:'王祖儿',totalQty:12680},{name:'马总',totalQty:15980},{name:'日常店播',totalQty:9800}]};
    else if(p==='/profiles/anchors/hot')data={hot:ids.map((pdtCode,i)=>({pdtCode,qty:1200-i*80,ratio:12-i}))};
    else if(p==='/profiles/anchors/audience')data={profile,used:ids.map(pdtCode=>({pdtCode,qty:1000})),missing:[],topN:20,name:u.searchParams.get('name'),updatedAt:new Date().toISOString()};
    else if(p.includes('hengji')&&p.includes('status'))data={loggedIn:true};
    else if(p==='/samples/by-codes')data={items:[],missing:[]};
    else if(p.includes('/remaining-inventory'))data={items:[],years:[2026]};
    else data={items:[],count:0,updatedAt:new Date().toISOString(),years:[2026]};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  await context.route('http://localhost:3721/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px sans-serif;padding:16px;background:#fafaf7;color:#6b685e}button{min-height:44px}</style><p>面料 / 翻单验收用内嵌页面</p><p>仅验证弹窗布局与原有回填消息，不连接真实外部服务。</p><button>验收操作</button></html>'}));
  // This socket replaces only browser networking during acceptance, leaving production code untouched.
  await context.addInitScript(()=>{window.WebSocket=class{static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=0;constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.();},25);}send(){}close(){this.readyState=3;}addEventListener(){}removeEventListener(){}};});
  const page=await context.newPage();
  currentPage=page;
  await page.goto('http://localhost:3000');
  if(scenario==='default')await page.getByRole('heading',{name:'货盘',exact:true}).waitFor();
  else await page.getByText(scenario==='empty'?'暂无货盘':'加载商品数据失败',{exact:true}).waitFor();
  return {context,page};
}
function nav(page,label){return page.locator('nav:visible').getByRole('button',{name:label,exact:true});}
async function measure(page,width,label){
  await page.waitForTimeout(150);
  const result=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:Array.from(document.querySelectorAll('main *')).filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.right>innerWidth+1&&!e.closest('.overflow-x-auto,[data-local-scroll]');}).slice(0,10).map(e=>({tag:e.tagName,cls:e.className,txt:e.textContent?.trim().slice(0,45),right:Math.round(e.getBoundingClientRect().right)}))}));
  reports.push({width,label,...result});
  if(result.scrollWidth>width+1)failures.push(`${width}px ${label}: document ${result.scrollWidth}px`);
  return result;
}
async function shot(page,file){
  const temporaryStyle=await page.addStyleTag({content:'[data-sonner-toaster] { visibility: hidden !important; }'});
  try{await page.screenshot({path:path.join(outDir,file),fullPage:false});}finally{await temporaryStyle.evaluate(e=>e.remove());}
}
try{
  if(mode==='baseline'){
    const {context,page}=await setup(390);
    await shot(page,'before-mobile.png');
    await measure(page,390,'baseline trays');
    await context.close();
  }else if(mode==='matrix'){
    for(const width of [320,375,390,430,768,1024,1440]){
      const {context,page}=await setup(width);
      await measure(page,width,'货盘列表');
      if(width===390)await shot(page,'after-trays.png');
      if(width===1440)await shot(page,'after-desktop.png');
      await page.locator('.tray-card').filter({hasText:'马总场'}).first().click();
      await page.getByRole('button',{name:'返回清单',exact:true}).waitFor();
      await measure(page,width,'货盘编辑');
      if(width===390)await shot(page,'after-editor.png');
      for(const [label,file] of [['直播排品','sequence'],['画像卡片','profile'],['天气面板','weather'],['配置后台','config']]){
        await nav(page,label).click();
        await page.getByRole('heading',{name:label,exact:true}).waitFor();
        await measure(page,width,label);
        if(width===390)await shot(page,`after-${file}.png`);
        if(label==='画像卡片'){
          for(const sub of ['店铺画像','主播热卖榜','画像对比','款号画像']){
            const button=page.getByRole('button',{name:sub,exact:true});
            if(await button.count()){await button.click();await measure(page,width,label+' / '+sub);}
          }
        }
      }
      await context.close();
    }
  }else if(mode==='interactive'){
    for(const width of [320,390]){
      const {context,page}=await setup(width);
      const prefix=`${width}px `;
      const navButtons=await page.locator('.mobile-nav button').evaluateAll(es=>es.map(e=>({w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})));
      check(prefix+'五项导航触屏尺寸',navButtons.length===5&&navButtons.every(b=>b.w>=44&&b.h>=44));
      await page.getByRole('button',{name:'新增货盘',exact:true}).click();
      await page.getByPlaceholder('货盘名称（如：马总场）').fill('手机验收货盘');
      await page.locator('.tray-create-form select').selectOption('店播直播货盘');
      await page.locator('.tray-create-form input[type="date"]').fill('2026-10-22');
      await measure(page,width,'新建货盘表单');
      await page.getByRole('button',{name:'创建并打开',exact:true}).click();
      await page.getByRole('heading',{name:'手机验收货盘',exact:true}).waitFor();
      check(prefix+'新建并打开货盘',await page.getByRole('heading',{name:'手机验收货盘',exact:true}).isVisible());
      await page.getByTitle('修改货盘名',{exact:true}).click();
      await page.locator('.tray-title input[type="text"]').fill('移动端验收：很长的货盘名称和日期需要自然换行');
      await page.locator('.tray-title input[type="text"]').press('Enter');
      await measure(page,width,'长名称货盘');
      check(prefix+'改名保存',await page.getByRole('heading',{name:'移动端验收：很长的货盘名称和日期需要自然换行',exact:true}).isVisible());
      await page.getByRole('button',{name:/「主推A」还没有坑位/}).click();
      const picker=page.getByRole('dialog',{name:'坑位选款',exact:true});
      await picker.waitFor();
      const pickerBox=await picker.boundingBox();
      check(prefix+'选款抽屉不超视口',pickerBox.x>=0&&pickerBox.width<=width&&pickerBox.height<=844);
      check(prefix+'抽屉背景锁定',await page.evaluate(()=>document.body.style.overflow==='hidden'));
      await picker.getByRole('button').filter({hasText:'羊毛混纺大衣'}).first().click();
      await picker.getByRole('button',{name:/确认放入（1 个款号）/}).click();
      await picker.waitFor({state:'hidden'});
      check(prefix+'选款写入坑位',await page.evaluate(()=>JSON.parse(localStorage.getItem('marius:trays:v2')).find(t=>t.name.startsWith('移动端验收')).sections[0].looks.length===1));
      check(prefix+'抽屉关闭恢复滚动',await page.evaluate(()=>document.body.style.overflow!=='hidden'));
      await page.getByRole('button',{name:'返回清单',exact:true}).click();
      const newCard=page.locator('.tray-card').filter({hasText:'移动端验收'});
      await newCard.getByTitle('删除货盘',{exact:true}).click();
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button',{name:'取消',exact:true}).click();
      check(prefix+'取消删除保留货盘',await newCard.count()===1);
      await page.locator('.tray-card').filter({hasText:'马总场'}).first().click();
      const sheet=page.locator('.tray-sheet').first();
      await sheet.scrollIntoViewIfNeeded();
      await sheet.evaluate(e=>{e.scrollLeft=e.scrollWidth;});
      check(prefix+'表格可滑到末尾',await sheet.evaluate(e=>e.scrollLeft>0));
      const sheetBox=await sheet.boundingBox(),labelBox=await sheet.locator('th').first().boundingBox();
      check(prefix+'左侧字段固定',Math.abs(sheetBox.x-labelBox.x)<=2);
      await sheet.evaluate(e=>{e.scrollLeft=0;});
      if(width===390){await sheet.evaluate(e=>window.scrollTo({top:e.getBoundingClientRect().top+scrollY-76}));await shot(page,'after-table.png');}
      await sheet.locator('img').first().click();
      const cover=page.getByRole('dialog',{name:'坑位多图管理',exact:true});
      await cover.waitFor();
      await measure(page,width,'多图管理');
      check(prefix+'多图弹窗宽度',((await cover.boundingBox()).width)<=width);
      await page.getByRole('button',{name:'关闭多图管理',exact:true}).click();
      await sheet.getByRole('button',{name:/编辑面料|查询面料/}).first().click();
      const iframeDialog=page.locator('.tray-iframe-dialog');
      await iframeDialog.waitFor();
      const iframeBox=await iframeDialog.boundingBox();
      check(prefix+'面料弹窗完整可见',iframeBox.x>=0&&iframeBox.y>=0&&iframeBox.width<=width&&iframeBox.y+iframeBox.height<=844);
      await page.evaluate(()=>window.postMessage({type:'fabric-selected',source:'fabric-query',payload:{text:'验收面料回填'}},'*'));
      await iframeDialog.waitFor({state:'hidden'});
      check(prefix+'面料回填保持原逻辑',await page.evaluate(()=>JSON.parse(localStorage.getItem('marius:trays:v2')).find(t=>t.id==='t1').fabricOverrides.me14dw030==='验收面料回填'));
      await sheet.getByRole('button',{name:/编辑翻单|查询翻单/}).first().click();
      await iframeDialog.waitFor();
      if(width===390)await shot(page,'after-restock-dialog.png');
      await page.evaluate(()=>window.postMessage({type:'restock-selected',source:'sales-page',pids:['me14dw030'],payload:{text:'黑色 100 件 / 12天'},text_by_pdt:{me14dw030:'黑色 100 件 / 12天'},items:[{pdt:'me14dw030',skc:'me14dw03001',color:'黑色',pieces:100,days:12}]},'*'));
      await page.waitForTimeout(100);
      check(prefix+'翻单回填保持原逻辑',await page.evaluate(()=>JSON.parse(localStorage.getItem('marius:trays:v2')).find(t=>t.id==='t1').plannedRestockItems?.some(i=>i.pieces===100&&i.days===12)));
      if(await iframeDialog.isVisible())await page.getByRole('button',{name:'关闭翻单信息',exact:true}).click();
      await page.getByRole('button',{name:'修改记录',exact:true}).click();
      const history=page.getByRole('dialog',{name:'修改记录',exact:true});
      await history.waitFor();
      check(prefix+'记录抽屉宽度',((await history.boundingBox()).width)<=width);
      await page.keyboard.press('Escape');
      await history.waitFor({state:'hidden'});
      await nav(page,'直播排品').click();
      await page.locator('.sequence-item').first().waitFor();
      const firstCode=await page.locator('.sequence-product').first().innerText();
      await page.locator('.sequence-item').first().getByTitle('下移',{exact:true}).click();
      check(prefix+'触屏下移',await page.locator('.sequence-product').first().innerText()!==firstCode);
      check(prefix+'存在保存按钮',await page.getByRole('button',{name:'保存排品',exact:true}).count()===1);
      await page.getByRole('button',{name:'保存排品',exact:true}).click();
      check(prefix+'排品保存写入',await page.evaluate(()=>JSON.parse(localStorage.getItem('marius:trays:v2')).find(t=>t.id==='t1').seqOrders.t1[1].lookId==='s1-L0'));
      const count=await page.locator('.sequence-item').count();
      await page.locator('.sequence-item').first().getByRole('button',{name:'返场',exact:true}).click();
      check(prefix+'追加返场',await page.locator('.sequence-item').count()===count+1);
      await page.getByRole('button',{name:'放弃修改',exact:true}).click();
      check(prefix+'放弃草稿恢复',await page.locator('.sequence-item').count()===count);
      await page.locator('.sequence-presets-toggle').click();
      await page.getByRole('button',{name:/日常场节奏/}).click();
      check(prefix+'手机策略生成并折叠',await page.getByRole('button',{name:'保存排品',exact:true}).count()===1&&await page.locator('.sequence-presets').getAttribute('open')===null);
      await page.getByRole('button',{name:'放弃修改',exact:true}).click();
      await page.getByRole('button',{name:'线轴',exact:true}).click();
      const timeline=page.locator('.sequence-page .overflow-x-auto').last();
      await timeline.evaluate(e=>e.scrollLeft=e.scrollWidth);
      check(prefix+'线轴可滑到末尾',await timeline.evaluate(e=>e.scrollLeft>0));
      await measure(page,width,'排品线轴');
      await page.getByRole('button',{name:'列表',exact:true}).click();
      await page.locator('.sequence-item').first().scrollIntoViewIfNeeded();
      if(width===390){await page.locator('.sequence-item').first().evaluate(e=>window.scrollTo({top:e.getBoundingClientRect().top+scrollY-76}));await shot(page,'after-sequence-cards.png');}
      await nav(page,'画像卡片').click();
      await page.getByRole('button',{name:'画像对比',exact:true}).click();
      await page.locator('.profile-page button').filter({hasText:'羊毛混纺大衣'}).first().click();
      await page.locator('.profile-comparison').waitFor();
      await measure(page,width,'已选商品画像对比');
      check(prefix+'对比两个平台纵向排列',await page.locator('.profile-comparison').evaluate(e=>getComputedStyle(e).flexDirection==='column'));
      await nav(page,'天气面板').click();
      await page.getByRole('button',{name:'杭州',exact:true}).click();
      await page.getByText('场景规则命中（杭州）',{exact:true}).waitFor();
      check(prefix+'城市切换',await page.getByRole('button',{name:'杭州',exact:true}).getAttribute('class').then(c=>c.includes('bg-action-primary')));
      await page.getByRole('heading',{name:'16日温度趋势',exact:true}).scrollIntoViewIfNeeded();
      if(width===390)await shot(page,'after-weather-charts.png');
      check(prefix+'图表父容器可缩小',await page.locator('canvas').evaluateAll(es=>es.every(e=>e.clientWidth>0&&e.clientWidth<=innerWidth)));
      await nav(page,'配置后台').click();
      await page.getByRole('button',{name:'保存规则',exact:true}).waitFor();
      const initialRules=structuredClone(ruleFixtures['role-rules'].rules);
      const firstInput=page.locator('.config-page input[type="number"]').first();
      check(prefix+'配置沿用初始值',await firstInput.inputValue()===String(initialRules.traffic.minConversion));
      await page.getByRole('button',{name:'保存规则',exact:true}).click();
      await page.getByText('角色规则已保存；到货盘点「手动同步」后角色标签重算生效',{exact:true}).waitFor();
      check(prefix+'保存配置只由测试截获',apiWrites.some(x=>x.width===width&&x.path==='/config/role-rules'));
      await page.evaluate(()=>window.scrollTo({top:document.body.scrollHeight}));
      await nav(page,'货盘').click();
      check(prefix+'导航复位滚动',await page.evaluate(()=>scrollY===0));
      await context.close();
    }
    for(const scenario of ['empty','error']){
      const {context,page}=await setup(320,scenario);
      await measure(page,320,scenario==='empty'?'无数据状态':'错误状态');
      if(scenario==='empty'){
        await page.getByRole('button',{name:'新建货盘',exact:true}).click();
        await page.getByRole('heading',{name:'货盘',exact:true}).waitFor();
        check('空数据仍能新建货盘',await page.locator('.tray-card').count()===1);
      }else check('失败状态显示重试',await page.getByRole('button',{name:'重试',exact:true}).isVisible());
      await context.close();
    }
  }else if(mode==='edge'){
    const {context,page}=await setup(390);
    await page.locator('.tray-card').filter({hasText:'马总场'}).first().click();
    await page.getByTitle('向坑位追加款号',{exact:true}).first().click();
    const picker=page.getByRole('dialog',{name:'坑位选款',exact:true});
    await picker.waitFor();
    await page.setViewportSize({width:390,height:568});
    const pickerBox=await picker.boundingBox();
    const confirmBox=await picker.getByRole('button',{name:/确认追加到坑位/}).boundingBox();
    check('短视口抽屉动态高度',pickerBox.height<=568&&pickerBox.y>=0);
    check('短视口底部提交可达',confirmBox.y+confirmBox.height<=568&&confirmBox.height>=44);
    await measure(page,390,'短视口选款抽屉');
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:844,height:390});
    await page.waitForTimeout(150);
    check('横屏转为平板导航',await page.locator('.desktop-nav').isVisible()&&!await page.locator('.mobile-nav').isVisible());
    await measure(page,844,'横屏编辑页');
    await page.emulateMedia({media:'print'});
    check('打印隐藏所有导航',await page.locator('nav:visible').count()===0);
    await context.close();
  }else if(mode==='board'){
    for(const file of [qaHtml,qaModule]){
      try{await fs.access(file);throw new Error('Refusing to replace existing QA file: '+file);}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    await fs.writeFile(qaHtml,'<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/src/__mobile-ui-qa.tsx"></script></html>');
    await fs.writeFile(qaModule,`import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import BoardPage from './sections/BoardPage';
import { ProductsProvider } from './data/ProductsContext';
import { type Product, type Tray, type TrayType } from './data/products';
import './index.css';
declare global { interface Window { __mobileQA: {products: Product[];trays:Tray[]}; } }
function Harness(){
  const [trays,setTrays]=useState(window.__mobileQA.trays);
  const [active,setActive]=useState('t1');
  const create=(name:string,type:TrayType,date:string)=>{const t:Tray={...trays[0],id:'qa-'+Date.now(),name,type,date,sections:[{id:'qa-section',label:'主推',visible:true,looks:[]}]};setTrays(ts=>[...ts,t]);setActive(t.id);return t;};
  const add=(pid:string,sectionId:string)=>setTrays(ts=>ts.map(t=>t.id!==active?t:{...t,sections:t.sections.map(s=>s.id!==sectionId?s:{...s,looks:[...s.looks,{id:'qa-look-'+Date.now(),pids:[pid],cover:pid}]})}));
  return <ProductsProvider products={window.__mobileQA.products}><BoardPage trays={trays} activeTrayId={active} onSwitchTray={setActive} onCreateTray={create} onAdd={add}/></ProductsProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);`);
    qaCreated=true;
    for(const width of [320,390,768,1440]){
      const {context,page}=await setup(width);
      await context.addInitScript(data=>{window.__mobileQA=data;},{products,trays:sampleTrays});
      await page.goto('http://localhost:3000/__mobile-ui-qa.html');
      await page.getByRole('heading',{name:'选款看板 · 主攻策略',exact:true}).waitFor();
      await measure(page,width,'选款看板');
      await page.getByRole('button',{name:'新建货盘',exact:true}).click();
      await measure(page,width,'选款看板新建表单');
      await page.getByPlaceholder('货盘名称',{exact:true}).fill('看板验收货盘');
      await page.getByRole('button',{name:'创建并选款',exact:true}).click();
      check(`${width}px 看板创建并选择`,await page.getByRole('button',{name:/看板验收货盘/}).count()>0);
      await page.getByRole('button',{name:'清仓场',exact:true}).click();
      check(`${width}px 看板快捷筛选`,await page.getByRole('button',{name:/清空条件/}).count()===1);
      if(width===390)await shot(page,'after-board.png');
      await context.close();
    }
  }
}catch(error){
  failures.push(error.stack||String(error));
  if(currentPage&&!currentPage.isClosed())await shot(currentPage,`${mode}-failure.png`).catch(()=>{});
}finally{
  await browser.close();
  if(qaCreated){await fs.unlink(qaModule);await fs.unlink(qaHtml);}
  await fs.writeFile(path.join(outDir,`${mode}-results.json`),JSON.stringify({mode,reports,interactions,failures,errors,apiWrites},null,2));
}
console.log(JSON.stringify({mode,checks:reports.length,interactions:interactions.length,failures,errors}));
if(mode!=='baseline'&&(failures.length||errors.length))process.exitCode=1;
