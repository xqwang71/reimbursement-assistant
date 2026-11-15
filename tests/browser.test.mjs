import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { browserTargetId } from '../lib/browser-session.mjs';
import { browserExecutable, pythonExecutable } from '../lib/platform.mjs';
import { ReimbursementExecutor } from '../lib/executor.mjs';
import { readWebProjectCatalog } from '../lib/projects.mjs';
import { officialQuote } from '../lib/boc-rates.mjs';
import { concretePurpose } from './fixtures.mjs';
import { allocateProjects } from '../public/project-allocation.js';
import { downloadSchoolReports } from '../lib/school-report-browser.mjs';
import { checkSchoolFinancePage } from '../lib/school-finance-access.mjs';
import { executeDailySchoolBooking } from '../lib/school-finance-runner.mjs';
import { executeSchoolPayroll } from '../lib/school-payroll-executor.mjs';
import { readSchoolPayrollStates } from '../lib/school-payroll-status.mjs';

const number = '12345678901234567890';
const reason = `${concretePurpose.matter}：${concretePurpose.use}`;
let browser;
let server;
let origin;
let uiChecks = 0;
let uiSourceRefresh;
let uiExecuteRequests = 0;
let uiPurposePayload;
let uiPreparedPlan;
let uiProject;
let uiMatch;
let uiReasonDraft;
let uiReasonSaved;
let uiGroup = null;
let uiSigner;
let uiSignerNames = [];
const uiTeachingSigner = { name: '示例教学加签人', employeeNo: '980001' };
let uiSignerRoster = [uiTeachingSigner];
let uiProjectSigners = {};
const uiFolder = '办公用品/模拟批次';
const uiSecondFolder = '办公用品/案例讲义';
const uiGroupKey = '@事项/11111111-1111-4111-8111-111111111111';
const uiArchived = '办公用品/归档批次-已报销';
const uiSourceRoot = '/模拟/2026';
const projectFixture = [
  { projectNo: 'TEST-2026-01', projectName: '模拟教学经费', department: '金融学院', totalCny: 500000, balanceCny: 100000 },
  { projectNo: 'TEST-2026-02', projectName: '模拟科研经费', department: '金融学院', totalCny: null, balanceCny: 0 },
];
const uiProjects = [...projectFixture, { projectNo: 'TEST-2026-03', projectName: '模拟案例经费', totalCny: 100000, balanceCny: 100000 }];
const sourceDir = fileURLToPath(new URL('..', import.meta.url));
function rememberUiSigner(signer) {
  if (signer && !uiSignerRoster.some(({ name, employeeNo }) => name === signer.name && employeeNo === signer.employeeNo)) {
    uiSignerRoster.push(signer);
  }
}

function uiSignerFields() {
  const projectSigner = uiProjectSigners[uiProject?.projectNo];
  const signerDefault = projectSigner ?? uiTeachingSigner;
  return { signerDefault, signerDefaultSource: projectSigner ? 'project' : 'funding', signerOverride: uiSigner ?? null, signer: uiSigner ?? signerDefault };
}
const uiPlan = () => ({ id: '22222222-2222-4222-8222-222222222222', folder: uiGroupKey, groupId: '11111111-1111-4111-8111-111111111111', displayName: uiFolder, sourceFolders: [uiFolder, uiSecondFolder], subject: '办公用品', funding: '教学', status: 'blocked', blockers: ['请先保存事由'], warnings: ['缺少已核对签字的签收单'], rows: [{ invoiceNumber: number, invoiceAmountCny: 10000, paidAmountCny: 9876, reimbursementAmountCny: 9876 }], totalCny: 9876, invoiceTotalCny: 10000, paidTotalCny: 9876, uploadFiles: ['发票.pdf', '付款凭证.png'], batches: [['发票.pdf', '付款凭证.png']], uploadSource: 'rule', uploadTypes: {}, supportingFiles: [], confirmations: {}, project: uiProject || { projectNo: '', projectName: '' }, reason: '', ...uiSignerFields(), fingerprint: 'fixture', cacheState: 'cached' });

async function payload(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

function budgetFixture() {
  return `<!doctype html><meta charset="utf-8">
  <div class="fast-reimbursement-cardFlex">
    <div class="fast-reimbursement-cardHead"><h2>经费预算信息</h2></div>
    <button hidden>添加</button><button id="add">添加</button>
  </div>
  <div class="fast-reimbursement-table" id="chosen">暂无数据</div>
  <div class="el-dialog" id="picker" hidden><h2>请选择预算项目</h2>
  <input id="search" placeholder="请输入项目名称/编号"><button id="query">查询</button>
  <table><thead><tr><th>选择</th><th>项目编号</th><th>项目内容</th><th>报销部门</th><th>预算金额</th></tr></thead><tbody id="choices"></tbody></table>
  <div class="el-pagination"><button class="btn-next">下一页</button></div>
  <button id="confirm">确认</button></div>
  <script>
    const projects = ${JSON.stringify(projectFixture)};
    const next = document.querySelector('.btn-next');
    const selected = window.selectedProjects = [];
    function show(project, hasNext) {
      const total = project.totalCny === null ? '—' : (project.totalCny / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
      document.getElementById('choices').innerHTML = '<tr><td><input type="checkbox" value="'+project.projectNo+'"></td><td>'+project.projectNo+'</td><td>'+project.projectName+'</td><td>'+project.department+'</td><td>'+total+'</td></tr>';
      next.disabled = !hasNext;
    }
    document.getElementById('add').onclick = () => {
      document.getElementById('search').value = '';
      show(projects[0], true);
      document.getElementById('picker').hidden = false;
    };
    next.onclick = () => setTimeout(() => show(projects[1], false), 250);
    document.getElementById('query').onclick = () => {
      const code = document.getElementById('search').value;
      const project = projects.find((item) => item.projectNo === code);
      if (project) show(project, false);
    };
    document.getElementById('confirm').onclick = () => {
      const code = document.querySelector('input:checked').value;
      selected.push(projects.find((item) => item.projectNo === code));
      const rows = selected.map((project) => '<tr><td>'+project.projectNo+'</td><td>'+project.projectName+'</td><td>'+(project.balanceCny/100).toLocaleString('en-US',{minimumFractionDigits:2})+'</td></tr>');
      document.getElementById('chosen').innerHTML = '<table><thead><tr><th>项目编号</th><th>项目内容</th><th>项目余额/授权金额</th></tr></thead><tbody>'+rows.join('')+'</tbody></table>';
      document.getElementById('picker').hidden = true;
    };
  </script>`;
}

function claimMenuFixture(target, priorFrame = '', otherFrame = '') {
  return `<!doctype html><meta charset="utf-8">
  <style>
    li.el-menu-item { position: relative; list-style: none; width: 240px; height: 40px; }
    li.el-menu-item > span { position: absolute; left: 42px; top: 10px; cursor: pointer; }
    i.star { position: absolute; left: 110px; top: 11px; width: 18px; height: 18px; cursor: pointer; }
    i.star::before { content: "★"; }
  </style>
  <ul><li class="el-submenu" aria-expanded="false">
    <div class="el-submenu__title">智能网报5.0</div>
    <ul hidden><li class="el-menu-item star-menu" role="menuitem"><span>我要报销</span><i class="star" title="收藏"></i></li></ul>
  </li></ul>
  ${priorFrame ? `<iframe id="prior" src="${priorFrame}"></iframe>` : ''}
  ${otherFrame ? `<iframe id="other" src="${otherFrame}"></iframe>` : ''}
  <iframe id="work" hidden style="width:100%;height:800px"></iframe>
  <script>
    window.favoriteClicks = 0;
    window.entryClicks = 0;
    const group = document.querySelector('.el-submenu');
    group.querySelector('.el-submenu__title').onclick = () => {
      const list = group.querySelector('ul');
      list.hidden = !list.hidden;
      group.setAttribute('aria-expanded', String(!list.hidden));
    };
    group.querySelector('i.star').onclick = () => { window.favoriteClicks += 1; };
    group.querySelector('li.el-menu-item > span').onclick = () => {
      window.entryClicks += 1;
      const prior = document.getElementById('prior');
      if (prior) prior.hidden = true;
      const work = document.getElementById('work');
      work.src = ${JSON.stringify(target)};
      work.hidden = false;
    };
  </script>`;
}

function fixtureHtml() {
  return `<!doctype html><meta charset="utf-8"><body><div id="app"></div><script>
  const state = {phase:'start',project:false,images:[],reason:${JSON.stringify(reason)},expense:'100.00',payment:'',bank:false,outer:false,inner:false,selected:false,files:[]};
  const invoice='${number}';
  const toolbar=(title,action)=>'<div class="fast-reimbursement-cardFlex"><div class="fast-reimbursement-cardHead"><div>'+title+'</div></div><button data-action="'+action+'">添加</button></div>';
  const budget=()=>toolbar('经费预算信息','project')+'<div class="el-table fast-reimbursement-table"><table><thead><tr><th>项目编号</th><th>项目名称</th><th>项目余额/授权金额</th></tr></thead></table><table><tbody>'+(state.project?'<tr><td>TEST-2026-01</td><td>测试项目</td><td>1000.00</td></tr>':'')+'</tbody></table>'+(!state.project?'暂无数据':'')+'</div>';
  const images=()=>'<div class="fast-reimbursement-divBottom">'+toolbar('票据影像<span></span>','images')+(state.images.length&&state.hideUploadNames?'<p>当前票据总张数:1张 当前票据总金额:￥100.00 元 当前附件总张数:'+(state.images.length-1)+'张</p>':'')+'<div class="theSecondStep-top"><div class="theSecondStep-divFlex uploaded-images">'+(state.images.length?(state.hideUploadNames?state.images.map(()=>'<div class="uploaded-file"></div>').join(''):state.images.map(name=>'<div class="uploaded-file" title="'+name+'">'+name+'</div>').join('')+'<p>'+invoice+'</p><p>发票张数：1 发票总额：100.00</p>'):'')+'</div></div></div>';
  const detail=()=>'<section><h2>报销支出费用明细</h2>'+(state.detailLoading?'':'<table><tr data-invoice-number="'+invoice+'"><td>'+invoice+'</td><td>金额<input placeholder="请输入金额" data-expense value="'+state.expense+'"><span>'+state.expense+'/100.00</span></td></tr></table><p>待分配金额：￥0.00</p>')+'</section>';
  function render(){
    let html='<p>报销单号：DOC-000001</p>';
    if(state.phase==='start') html+='<div class="el-card"><div class="el-card__body">'+toolbar('业务单信息','business')+budget()+images()+'</div></div><button data-action="next">下一步</button>';
    if(state.phase==='type') html+='<button data-action="type">日常报销</button><button data-action="fill">单据填报</button>';
    if(state.phase==='form') html+='<h1>单据填报-日常报销</h1><input role="textbox" aria-autocomplete="list" value="'+state.reason+'" data-reason><button data-action="save-form">保存并下一步</button>';
    if(state.phase==='expense-type') html+='<div class="el-dialog"><h2>请确认明细费用类型</h2><div class="nextClick-body">'+invoice+'<label class="el-radio"><input type="radio" name="expense">办公费</label></div><button data-action="save-type">确认</button></div>';
    if(state.phase==='detail') html+='<h1>单据填报-日常报销</h1>'+detail()+'<section><h2>支付信息</h2>'+(state.bank?'<p>教职工银行-建设银行</p><input placeholder="请输入金额" data-payment value="'+state.payment+'"><p id="remaining">待支付金额:￥'+(Number(state.expense)-Number(state.payment)).toFixed(2)+'</p>':'<button data-action="add-bank">添加支付类型</button>')+'<button data-action="save-payment">保存并下一步</button></section>';
    if(state.phase==='bank') html+='<button data-action="select-bank">教职工银行-建设银行</button>';
    if(state.phase==='signer') html+='<h1>单据填报-日常报销</h1><p>TEST-2026-01 '+state.reason+'</p><p>报销金额：90.00</p>'+detail()+'<div class="el-dialog"><h2>请选择线上审批加签人</h2><button data-action="add-signer">加签人</button><p>'+(state.selected?'980001—示例教学加签人':'')+'</p><button data-action="confirm-signer">确认</button></div>'+(state.inner?'<div class="el-dialog"><h2>查询</h2><input placeholder="请输入姓名"><button data-action="query">查询</button><table><tr><td><input type="checkbox"></td><td>示例教学加签人</td><td>980001</td></tr></table><button data-action="choose-signer">确认</button></div>':'');
    if(state.phase==='confirm') html+='<h1>确认提交报销单</h1><p>'+state.reason+'</p><p>TEST-2026-01 测试项目 示例教学加签人 980001</p><p>'+invoice+'</p><p>报销金额：90.00</p><button id="submit" data-action="submit">提交预审</button>';
    document.getElementById('app').innerHTML=html;
  }
  document.addEventListener('input',event=>{if(event.target.hasAttribute('data-reason'))state.reason=event.target.value;if(event.target.hasAttribute('data-expense'))state.expense=event.target.value;if(event.target.hasAttribute('data-payment')){state.payment=event.target.value;document.getElementById('remaining').textContent='待支付金额:￥'+(Number(state.expense)-Number(state.payment)).toFixed(2);}});
  document.addEventListener('change',event=>{if(event.target.id==='choose')state.files=Array.from(event.target.files,x=>x.name);});
  document.addEventListener('click',event=>{
    const action=event.target.getAttribute('data-action'); if(!action)return;
    if(action==='business'){window.businessClicks=(window.businessClicks||0)+1;return;}
    if(action==='project'){document.getElementById('app').insertAdjacentHTML('beforeend','<div class="el-dialog"><h2>请选择预算项目</h2><table><thead><tr><th></th><th>项目编号</th><th>项目名称</th></tr></thead><tbody><tr><td><label class="el-checkbox"><input type="checkbox" style="position:absolute;width:0;height:0;opacity:0">选择</label></td><td>TEST-2026-01</td><td>测试项目</td></tr></tbody></table><button data-action="confirm-project">确认</button></div>');return;}
    if(action==='confirm-project'){if(!document.querySelector('.el-dialog input:checked'))return;state.project=true;}
    if(action==='images'){document.getElementById('app').insertAdjacentHTML('beforeend','<button data-action="device">从本设备选择</button>');return;}
    if(action==='device'){document.getElementById('app').insertAdjacentHTML('beforeend',state.project?'<div class="el-dialog"><button data-action="choose">点击上传</button><input id="choose" type="file" multiple hidden><button data-action="upload">上传</button></div>':'<div class="el-message">请选择预算项目</div>');return;}
    if(action==='choose'){document.getElementById('choose').click();return;}
    if(action==='upload')state.images.push(...state.files);
    if(action==='next')state.phase='type';
    if(action==='fill')state.phase='form';
    if(action==='save-form'){
      if(state.expenseDialogDelay){
        setTimeout(()=>{state.phase='expense-type';render();},state.expenseDialogDelay);
        return;
      }
      state.phase='expense-type';
    }
    if(action==='save-type'){
      state.phase='detail';
      if(state.detailDelay){
        state.detailLoading=true;
        setTimeout(()=>{state.detailLoading=false;render();},state.detailDelay);
      }
    }
    if(action==='add-bank')state.phase='bank';
    if(action==='select-bank'){state.bank=true;state.phase='detail';}
    if(action==='save-payment')state.phase='signer';
    if(action==='add-signer'){state.inner=true;}
    if(action==='query')return;
    if(action==='choose-signer'){state.inner=false;state.selected=true;}
    if(action==='confirm-signer'){
      if(state.submitFromSigner){
        window.signerSubmitClicks=(window.signerSubmitClicks||0)+1;
        history.replaceState(null,'','/ClaimsPublicPCWeb/expenseAccountInquiry?code=FIXTURE-0001');
        document.getElementById('app').innerHTML='<p>您的报销单:FIXTURE-0001</p><p>已处理完成</p><p>提交预审 预审通过</p>';
        return;
      }
      state.phase='confirm';
    }
    if(action==='submit'){window.submitClicks=(window.submitClicks||0)+1;document.getElementById('app').insertAdjacentHTML('beforeend','<div class="el-message el-message--success">提交成功</div>');return;}
    render();
  });
  window.fixtureState=state;window.fixtureRender=render;render();
  </script>`;
}

test.before(async () => {
  server = http.createServer(async (request, response) => {
    if (['/runner', '/app.js', '/styles.css', '/project-allocation.js', '/model-settings.js', '/funding-summary.js', '/payroll.js', '/review-archive.js', '/signer-picker.js'].includes(request.url)) {
      const name = request.url === '/runner' ? 'index.html' : request.url.slice(1);
      response.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
      return response.end(await readFile(join(sourceDir, 'public', name)));
    }
    if (request.url.startsWith('/api/')) {
      response.setHeader('content-type', 'application/json; charset=utf-8');
      const json = (value) => response.end(JSON.stringify(value));
      if (request.url === '/api/health') return json({ ok: true, deepseekConfigured: false, model: 'fixture' });
      if (request.url === '/api/config') return json({ sourceRoot: uiSourceRoot, defaultSourceRoot: uiSourceRoot, paymentCardConfigured: true });
      if (request.url === '/api/projects') return json({ projects: uiProjects.map(({ projectNo, projectName }) => ({ projectNo, projectName })), syncedAt: null, projectSigners: uiProjectSigners });
      if (request.url === '/api/projects/sync') return json({ projects: uiProjects, syncedAt: '2026-11-10T01:00:00Z', projectSigners: uiProjectSigners });
      if (request.url === '/api/project-signer') {
        const { sourceRoot, projectNo, signer } = await payload(request);
        assert.equal(sourceRoot, uiSourceRoot);
        if (signer) uiProjectSigners[projectNo] = signer;
        else delete uiProjectSigners[projectNo];
        rememberUiSigner(signer);
        return json({ projectSigners: uiProjectSigners, signerRoster: uiSignerRoster });
      }
      if (request.url === '/api/folders') return json({ sourceRoot: uiSourceRoot, signerNames: uiSignerNames, signerRoster: uiSignerRoster, folders: [{ path: uiArchived, fileCount: 3, reimbursed: true }, ...[uiFolder, uiSecondFolder].map(path => ({ path, fileCount: uiSourceRefresh && path === uiFolder ? 4 : 3, reimbursed: false, claimKey: uiGroup?.key, claimLabel: uiGroup?.name }))], claims: [{ path: uiArchived, fileCount: 3, reimbursed: true }, ...(uiGroup ? [{ path: uiGroup.key, groupId: uiGroup.id, label: uiGroup.name, sourceFolders: uiGroup.folders, subject: '办公用品', fileCount: 6, reimbursed: false, match: uiMatch, reasonDraft: uiReasonDraft, reasonSaved: uiReasonSaved, offlineBooking: uiGroup.bookingOptions?.offline === true }] : [])] });
      if (request.url === '/api/claim-groups') {
        const input = await payload(request);
        assert.deepEqual(input.folders.sort(), [uiFolder, uiSecondFolder].sort());
        assert.ok(['legacy', 'smart'].includes(input.reimbursementRoute));
        uiGroup = { key: uiGroupKey, id: '11111111-1111-4111-8111-111111111111', name: uiFolder, folders: input.folders, bookingOptions: input.reimbursementRoute === 'legacy' ? { offline: true, attachmentCount: null } : null };
        response.statusCode = 201;
        return json({ group: uiGroup });
      }
      if (request.method === 'PATCH' && request.url === `/api/claim-groups/${uiGroup?.id}`) {
        const { sourceRoot, reimbursementRoute } = await payload(request);
        assert.equal(sourceRoot, uiSourceRoot);
        assert.ok(['legacy', 'smart'].includes(reimbursementRoute));
        uiGroup.bookingOptions = reimbursementRoute === 'legacy' ? { offline: true, attachmentCount: null } : null;
        return json({ group: uiGroup });
      }
      if (request.method === 'DELETE' && request.url === `/api/claim-groups/${uiGroup?.id}`) {
        assert.equal((await payload(request)).sourceRoot, uiSourceRoot);
        const group = { ...uiGroup, match: uiMatch, status: 'dissolved' };
        uiGroup = null;
        return json({ group });
      }
      if (request.url === '/api/claim-reason') {
        const input = await payload(request);
        assert.equal(input.sourceRoot, uiSourceRoot);
        assert.equal(input.folder, uiGroupKey);
        uiReasonDraft = input.reason;
        uiReasonSaved ||= input.explicit === true && Boolean(input.reason);
        return json({ reasonDraft: uiReasonDraft, reasonSaved: uiReasonSaved });
      }
      if (request.url === '/api/project-match') {
        const input = await payload(request);
        assert.equal(input.sourceRoot, uiSourceRoot);
        assert.equal(input.folder, uiGroupKey);
        if (!input.importOnly || uiMatch === undefined) uiMatch = input.match;
        return json({ match: uiMatch });
      }
      if (request.url === '/api/plan-override') {
        const { folder, signerOverride } = await payload(request);
        assert.equal(folder, uiGroupKey);
        if (signerOverride !== undefined) uiSigner = signerOverride;
        if (uiSigner && !uiSignerNames.includes(uiSigner.name)) uiSignerNames.push(uiSigner.name);
        rememberUiSigner(uiSigner);
        uiPreparedPlan = { ...uiPreparedPlan, ...uiSignerFields() };
        return json({ plan: uiPreparedPlan, signerNames: uiSignerNames, signerRoster: uiSignerRoster });
      }
      if (request.url === '/api/runs') return json({ runs: [] });
      if (request.url === '/api/batches') return json({ batches: [] });
      if (request.url === '/api/login-status') return json({ loggedIn: true, message: '本地模拟页面' });
      if (request.url === '/api/plans') {
        const input = await payload(request);
        if (uiSourceRefresh && input.folder === uiFolder) {
          await uiSourceRefresh;
          return json({ plan: { ...uiPlan(), folder: input.folder, totalCny: 3850, invoiceTotalCny: 5000, fingerprint: 'fixture-updated', cacheState: 'new' } });
        }
        if ([uiFolder, uiSecondFolder].includes(input.folder)) return json({ plan: { ...uiPlan(), folder: input.folder, totalCny: 4938, invoiceTotalCny: 5000 } });
        uiChecks += 1;
        assert.equal(input.folder, uiGroupKey);
        uiProject = input.project;
        const plan = { ...uiPlan(), funding: uiMatch?.funding || '教学', reimbursementRoute: uiGroup?.bookingOptions?.offline ? 'legacy' : 'smart' };
        if (uiMatch?.allocations) {
          const { error } = allocateProjects(uiMatch.allocations, plan.totalCny);
          Object.assign(plan, { projectAllocationDraft: uiMatch.allocations, reason: uiReasonSaved ? uiReasonDraft : '', status: error || !uiReasonSaved ? 'blocked' : 'ready', blockers: error ? [error] : [] });
          if (plan.status === 'ready') uiPreparedPlan = plan;
        }
        return json({ plan, match: uiMatch });
      }
      if (request.method === 'POST' && request.url === `/api/plans/${uiPlan().id}/purpose`) {
        uiPurposePayload = await payload(request);
        uiPreparedPlan = { ...uiPlan(), status: 'ready', blockers: [], reason: uiPurposePayload.reason, purpose: uiPurposePayload };
        return json({ plan: uiPreparedPlan });
      }
      if (request.url === '/api/batch-runs') {
        uiExecuteRequests += 1;
        assert.deepEqual((await payload(request)).planIds, [uiPreparedPlan.id]);
        response.statusCode = 202;
        return json({ batch: { id: 'fixture-batch', status: 'preview', currentIndex: 0, currentRunId: 'fixture-run', runs: [{ id: 'fixture-run', plan: uiPreparedPlan, status: 'preview', events: [], messages: [] }] } });
      }
      response.statusCode = 404;
      return json({ error: 'unknown fixture route' });
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/school-portal') return response.end(claimMenuFixture('/project-budget', '', '/project-decoy'));
    if (request.url === '/claim-entry') return response.end(claimMenuFixture('/ClaimsPublicPCWeb/fast-reimbursement', '/ClaimsPublicPCWeb/expenseAccountInquiry'));
    if (request.url === '/project-budget') return response.end(budgetFixture());
    if (request.url === '/project-decoy') return response.end('<section hidden><h2>经费预算信息</h2><button>添加</button></section>');
    if (request.url.startsWith('/ClaimsPublicPCWeb/expenseAccountInquiry')) return response.end('<p>其他历史单据 提交成功</p>');
    if (/^\/ClaimsPublicPCWeb\/(?:filling|fast-reimbursement)/.test(request.url)) return response.end(fixtureHtml());
    response.end('<iframe src="/ClaimsPublicPCWeb/filling" style="width:1200px;height:900px"></iframe><iframe src="/ClaimsPublicPCWeb/expenseAccountInquiry" style="display:none"></iframe>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  // Exercise the PDF viewer in the same browser that the application uses.
  browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: ['--disable-background-networking'] });
});
test.after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

test('settings open from the header and persist a model assignment without showing credentials', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1150, height: 780 } });
  t.after(() => context.close());
  const uses = { attachments: '附件识别', travel: '差旅核对', interaction: '执行互动', recovery: '故障恢复' };
  let settings = {
    connections: [{ id: 'deepseek', name: 'DeepSeek API', kind: 'api', baseUrl: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', keyConfigured: true }, { id: 'codex', name: 'Codex', kind: 'codex', keyConfigured: false }],
    models: [{ id: 'deepseek', name: 'DeepSeek', connectionId: 'deepseek', model: 'deepseek-chat', effort: '' }, { id: 'codex', name: 'Codex 默认', connectionId: 'codex', model: '', effort: '' }],
    assignments: Object.fromEntries(Object.keys(uses).map((purpose) => [purpose, 'deepseek'])), uses,
  };
  await context.route('**/api/model-settings', async (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      assert.equal(input.assignments.recovery, 'codex');
      assert.equal(input.connections[0].keyEnv, 'DEEPSEEK_API_KEY');
      assert.equal(input.connections[0].apiKey, undefined);
      settings = { ...settings, assignments: input.assignments };
    }
    await route.fulfill({ json: settings });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/runner`);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await dialog.getByLabel('故障恢复').waitFor();
  assert.equal(await dialog.getByLabel('票据根目录').inputValue(), uiSourceRoot);
  assert.equal(await dialog.getByLabel('API Key 环境变量名').inputValue(), 'DEEPSEEK_API_KEY');
  await dialog.getByText('已读取本机环境变量中的 API Key。').waitFor();
  await dialog.getByLabel('故障恢复').selectOption('codex');
  await dialog.getByRole('button', { name: '保存模型设置' }).click();
  await dialog.getByText('模型设置已保存。').waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 760 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await dialog.getByLabel('故障恢复').waitFor();
  assert.equal(await dialog.getByLabel('故障恢复').inputValue(), 'codex');
  assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth));
});

test('worklist shows the two access routes and an auditable funding progress bar', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1180, height: 760 } });
  t.after(() => context.close());
  const categories = { labor: '劳务费', transport: '市内交通费', other: '其他费用' };
  const amounts = { labor: 10000, transport: 15000, other: 25000 };
  const totals = { bookedCny: 50000, pendingCny: 20000, submittedCny: 20000, progressCny: 70000, budgetCny: 100000, coveredCny: 70000, rate: 0.7,
    categories: amounts, progressCategories: { ...amounts, other: 45000 }, localPendingCny: 20000, hasSchoolData: true, hasProgressData: true };
  const result = { year: '2026', sourceRoot: uiSourceRoot, totals, categories, issues: [], unassigned: [],
    sources: [{ kind: 'smart', file: '报销单统计.xlsx', state: 'read', rowCount: 1, lastDate: '2026-08-01' }],
    projects: [{ ...totals, key: 'A1A-TEST-01', projectNo: 'A1A-TEST-01', name: '模拟教学经费', budgetSource: '年度台账', unassignedCny: 25000, unassignedProgressCny: 45000,
      records: [
        { key: 'receipt:123:A1A-TEST-01', financeId: '123', date: '2026-08-01', category: 'other', amountCny: 25000, status: '已制单', state: 'booked', ledgerNo: '', source: { file: '报销单统计.xlsx', sheet: 'sheet1', row: 2 } },
        { key: 'receipt:124:A1A-TEST-01', financeId: '124', date: '2026-08-01', category: 'other', amountCny: 20000, status: '已收学校回执', state: 'pending', countsTowardProgress: true, ledgerNo: '', source: { file: '执行助手回执' } },
      ],
      lines: ['A', 'B'].map((ledgerNo) => ({ ledgerNo, name: `台账 ${ledgerNo}`, budgetCny: 50000, bookedCny: 0, submittedCny: 0, progressCny: 0, file: '年度台账.xlsx', row: 5,
        budgetNote: ledgerNo === 'B' ? '按学校余额推算。' : '' })),
    }, {
      key: 'ledger:C', projectNo: '', name: '系部经费', budgetCny: 50000, budgetSource: '年度台账', rate: null,
      bookedCny: 0, submittedCny: 0, progressCny: 0, progressCategories: { labor: 0, transport: 0, other: 0 }, records: [],
      lines: [{ ledgerNo: 'C', handlingMode: '托人报销', handlingPerson: '示例代办人', file: '年度台账.xlsx', row: 7 }],
    }, {
      key: 'ledger:D', projectNo: '', name: '授课报销额度', budgetCny: 400000, budgetSource: '年度台账', rate: null,
      bookedCny: 0, submittedCny: 0, progressCny: 0, progressCategories: { labor: 0, transport: 0, other: 0 }, records: [],
      lines: [{ ledgerNo: 'D', handlingMode: '托人报销', handlingPerson: '蒋老师', handlingStatus: '已完成', file: '年度台账.xlsx', row: 8 }],
    }],
  };
  await context.route('**/api/funding-summary', (route) => route.fulfill({ json: result }));
  await context.route('**/api/funding-summary/attribution', async (route) => {
    assert.deepEqual(route.request().postDataJSON(), { sourceRoot: uiSourceRoot, recordKey: 'receipt:123:A1A-TEST-01', ledgerNo: 'B' });
    result.projects[0].records[0].ledgerNo = 'B';
    result.projects[0].lines[1].bookedCny = 25000;
    result.projects[0].lines[1].progressCny = 25000;
    result.projects[0].unassignedCny = 0;
    result.projects[0].unassignedProgressCny = 20000;
    await route.fulfill({ json: { saved: true } });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/runner`);
  const access = page.getByRole('complementary', { name: '报销系统登录说明' });
  await access.getByText('校外可直接扫码登录。').waitFor();
  assert.equal(await access.getByRole('link', { name: /零信任客户端/ }).getAttribute('href'), 'https://lxr.suibe.edu.cn/');
  assert.deepEqual(await page.locator('#claimRouteFilter option').evaluateAll((options) => options.map((option) => option.value)), ['', 'smart', 'legacy', 'labor', 'didi']);
  const summary = page.getByRole('region', { name: '报销汇总' });
  await summary.getByText('学校表最晚记录 2026-08-01', { exact: false }).waitFor();
  assert.equal(await summary.locator('#fundingTotals').getByText('70%', { exact: true }).count(), 1);
  assert.equal(await summary.locator('#fundingTotals > div').filter({ hasText: '学校已报销' }).locator('strong').innerText(), '¥500.00');
  assert.equal(await summary.locator('#fundingTotals > div').filter({ hasText: '已提交待入账' }).locator('strong').innerText(), '¥200.00');
  assert.equal(await summary.locator('[data-funding-project="A1A-TEST-01"] .funding-rate').innerText(), '70%');
  assert.deepEqual(await summary.locator('.funding-bar > span').evaluateAll((bars) => bars.map((bar) => bar.style.width)), ['10%', '15%', '45%']);
  const entrusted = summary.locator('[data-funding-project="ledger:C"]');
  await entrusted.getByText('年度台账 · 托人报销 · 示例代办人', { exact: true }).waitFor();
  assert.equal(await entrusted.locator('.funding-rate').innerText(), '进度待核对');
  assert.equal(await entrusted.locator('.funding-project-money strong').innerText(), '—');
  const completed = summary.locator('[data-funding-project="ledger:D"]');
  assert.equal(await completed.locator('.funding-rate').innerText(), '已完成');
  assert.equal(await completed.getByText('预算 ¥4,000.00').count(), 1);
  await summary.getByText('模拟教学经费', { exact: true }).click();
  await summary.getByText('按学校余额推算。', { exact: true }).waitFor();
  await summary.getByText('报销单统计.xlsx · sheet1 · 第 2 行', { exact: true }).waitFor();
  await summary.getByRole('row').filter({ hasText: '已收学校回执' }).getByText('已提交待入账', { exact: true }).waitFor();
  const selected = summary.getByLabel('单据 123 的台账名目');
  await selected.selectOption('B');
  await summary.getByText(/还有 ¥200.00 待归属/).waitFor();
  assert.equal(await selected.inputValue(), 'B');
  await summary.getByText('数据来源与导出', { exact: true }).click();
  assert.match(await summary.getByRole('link', { name: '下载原始 Excel' }).getAttribute('href'), /funding-summary\/source\?file=.*\.xlsx$/);
  await page.setViewportSize({ width: 390, height: 760 });
  assert.ok(await summary.evaluate((element) => element.scrollWidth <= element.clientWidth));
});

test('payroll sync queries January through December and downloads only eligible nonempty categories', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const directory = await mkdtemp(join(tmpdir(), 'suibe-payroll-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = `${origin}/test-payroll`;
  await context.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
    <h2>薪资套类</h2>
    <a class="linkTab linkTabOn" href="#">校外人员劳务费</a>
    <a class="linkTab" href="#">学生劳务费</a>
    <a class="linkTab" href="#">博士后工资</a>
    <a class="linkTab" href="#">地铁强生派遣工资</a>
    <a class="linkTab" href="#">教育发展基金会校外</a>
    <a class="linkTab" href="#">工会校外</a>
    <a class="linkTab" href="#">学生基金会</a>
    <input id="dd_StratYear" hidden><input id="dd_EndYear" hidden><input id="dd_StartMonth" hidden><input id="dd_EndMonth" hidden>
    <button id="query">查询</button><button id="export">导出</button><div class="k-grid">结果</div>
    <script>
      const widgets = new Map();
      const months = Array.from({length:12}, (_, index) => ({key:String(index+1)}));
      for(const input of document.querySelectorAll('input')){
        let current = input.id.includes('Year') ? '2025' : '11';
        widgets.set(input,{options:{dataValueField:'key'},dataSource:{view:()=>input.id.includes('Year')?[{key:'2025'},{key:'2026'}]:chosen()==='地铁强生派遣工资'?[{key:'11'}]:months},
          value(next){if(next!==undefined)current=next;return current;},trigger(){}});
      }
      window.queries=[]; window.exports=[]; let count=0;
      window.jQuery=(node)=>({data:(name)=>name==='kendoDropDownList'?widgets.get(node):{dataSource:{total:()=>count}}});
      window.jQuery.active=1;
      const chosen=()=>document.querySelector('.linkTabOn').textContent;
      for(const tab of document.querySelectorAll('.linkTab'))tab.onclick=(event)=>{event.preventDefault();document.querySelector('.linkTabOn').classList.remove('linkTabOn');tab.classList.add('linkTabOn');};
      query.onclick=()=>{window.queries.push([chosen(),...[...widgets.values()].map(widget=>widget.value())]);count=['学生劳务费','地铁强生派遣工资'].includes(chosen())?0:1;};
      document.getElementById('export').onclick=()=>{window.exports.push(chosen());const link=document.createElement('a');link.download='薪资套类汇总导出.xls';link.href=URL.createObjectURL(new Blob([chosen()]));link.click();};
    </script>` }));
  const page = await context.newPage();
  const saved = [];
  let completedQueries = 0;
  await downloadSchoolReports({ page, url, kind: 'labor', year: '2026', directory, signal: AbortSignal.timeout(20000), onState() {},
    async save(artifact) {
      saved.push(artifact);
      if (!artifact.skipped) {
        assert.match(artifact.downloadPath, /薪资套类汇总导出\.xls$/);
        assert.equal(await readFile(artifact.downloadPath, 'utf8'), artifact.category);
      }
    },
    async onReport(frame) { completedQueries = await frame.evaluate(() => window.queries.length); },
  });
  assert.equal(completedQueries, 4);
  assert.deepEqual(await page.evaluate(() => window.queries), [
    ...['校外人员劳务费', '学生劳务费', '博士后工资'].map((name) => [name, '2026', '2026', '1', '12']),
    ['地铁强生派遣工资', '2026', '2026', '11', '11'],
  ]);
  assert.deepEqual(await page.evaluate(() => window.exports), ['校外人员劳务费', '博士后工资']);
  assert.deepEqual(saved.filter(({ skipped }) => skipped).map(({ category, fromMonth, throughMonth }) => [category, fromMonth, throughMonth]), [['学生劳务费', 1, 12], ['地铁强生派遣工资', 11, 11]]);
});

test('school finance checks both blank forms in one tab and stops before saving', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'aws.suibe.edu.cn' && url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      '<a target="_blank" href="/r/or?kind=legacy">财务系统</a><a target="_blank" href="/r/or?kind=labor">薪酬申报</a>' });
    if (url.hostname === 'aws.suibe.edu.cn' && url.pathname === '/r/or') {
      const next = url.searchParams.get('kind') === 'legacy' ? '/SFP_Cms/Home/Index' : '/SFP_SalarySelf/SalaryDeclareManagement/';
      return route.fulfill({ contentType: 'text/html; charset=utf-8',
        body: `<script>setTimeout(() => location.replace("https://cwc.suibe.edu.cn${next}"), 20)</script>` });
    }
    if (url.hostname !== 'cwc.suibe.edu.cn') return route.abort();
    if (url.pathname === '/SFP_Cms/Home/Index') return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      '<a href="/SFP_Cms/Home/FApp" onclick="event.preventDefault(); document.querySelector(\'iframe\').src = \'/SFP_Claims1Self\'">网上预约报销</a><iframe></iframe>' });
    if (url.pathname === '/SFP_Cms/Home/FApp') return route.fulfill({ status: 500, body: 'open through the booking control' });
    if (url.pathname === '/SFP_Claims1Self') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <a href="#" onclick="document.querySelector('#appointment').hidden = false">其他事项报销</a>
      <div id="appointment" hidden><input id="txt_Remark"><a href="#">添加经费项目</a><a href="#">上传附件信息</a>
      <a href="#" onclick="window.saved = true">保存并提交</a></div>` });
    if (url.pathname === '/SFP_SalarySelf/SalaryDeclareManagement/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <a href="#" class="linkTab">校外人员劳务费</a><a href="#" class="linkTab">学生劳务费</a><a href="#" class="linkTab">工会劳务费</a>
      <a href="#">薪资申报</a><a href="#" onclick="document.querySelector('#heading').hidden = false">创建</a>
      <div id="heading" hidden><input id="txt_GrantContent"><a href="#" onclick="window.saved = true">保存</a></div>` });
    return route.abort();
  });
  const page = await context.newPage();
  const check = (kind) => checkSchoolFinancePage(page, { kind, signal: AbortSignal.timeout(14000) });
  assert.equal((await check('legacy')).status, 'form_verified');
  assert.equal(await page.frame({ url: /SFP_Claims1Self/ }).evaluate(() => window.saved), undefined);
  const payroll = await check('labor');
  assert.equal(payroll.status, 'form_verified');
  assert.deepEqual(payroll.categories, ['校外人员劳务费', '学生劳务费']);
  assert.equal(await page.evaluate(() => window.saved), undefined);
  assert.equal(context.pages().length, 1);
});


test('daily booking saves and sends the original PDF before verifying submission in the school query', async (t) => {
  for (const popup of [true, false]) await t.test(popup ? 'school PDF popup' : 'query print fallback', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'runner-appointment-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const folder = '模拟票据';
    await mkdir(join(directory, folder));
    const context = await browser.newContext();
    t.after(() => context.close());
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(Date.now() + 86400000);
    const [year, month, day] = date.split('-');
    const financeFormId = '9999999999902';
    const orderId = '20000000-0000-4000-8000-000000000001';
    const projectId = '20000000-0000-4000-8000-000000000002';
    const project = { projectNo: 'TEST-2026-01', projectName: '模拟经费' };
    const plan = { folder, reason: '模拟课程案例材料', project, totalCny: 14264, attachmentCount: 3, fingerprint: 'test-booking' };
    // Embed a Chinese font so the same PDF text is available on each runner.
    const receiptText = [`报销单 ${financeFormId}`, `预约日期 ${date} 松江本部`, `报销事由 ${plan.reason}`, '附件张数 3', `${project.projectNo} 142.64`];
    const receiptPath = join(directory, 'school-receipt.pdf');
    execFileSync(pythonExecutable(), ['-X', 'utf8', '-c', [
      'import fitz, json, sys',
      'with fitz.open() as pdf:',
      '    page = pdf.new_page()',
      '    font = fitz.Font("cjk")',
      '    writer = fitz.TextWriter(page.rect)',
      '    for i, line in enumerate(json.loads(sys.argv[1])):',
      '        writer.append((36, 48 + 22 * i), line, font=font, fontsize=12)',
      '    writer.write_text(page)',
      '    pdf.subset_fonts()',
      '    pdf.save(sys.argv[2], deflate=True)',
    ].join('\n'), JSON.stringify(receiptText), receiptPath], { timeout: 10000 });
    const original = await readFile(receiptPath);
    assert.equal(original.subarray(0, 5).toString(), '%PDF-');
    assert.match(original.subarray(-64).toString(), /%%EOF\s*$/);
    const row = {
      OrderID: orderId, OrderNo: financeFormId, OrderStateName: '提交', SettlementAmount: 142.64, ActualAmount: 0,
      ProjectNameList: project.projectNo, ProjectIDList: projectId, Remark: plan.reason,
      LocalName: '松江本部', ReserveDate_Str: date + '全天', TotalAttachments: 0,
    };
    let submissions = 0;
    const events = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'cwc.suibe.edu.cn') return route.abort();
      if (url.pathname.endsWith('/COC_ClaimsOrderCreateDaily/Save_DailyOrder')) {
        assert.equal(route.request().method(), 'POST');
        submissions += 1;
        return route.fulfill({ json: { Successed: true } });
      }
      if (url.pathname !== '/SFP_Claims1Self') return route.abort();
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <input type="hidden" id="Hid_OrderId" value="${orderId}">
        <input id="txt_Remark"><input id="txt_CLUI_Mobile" value="test-phone">
        <input id="SumAmount" value="142.64"><input id="txt_SOS㊙ReceiptNumber">
        <div id="div_ExpendProInfo_Tabs"><input name="row㊙PayAmount"><input name="row㊙Remark">
          <input name="row㊙InvoiceNumber" oninput="document.getElementById('txt_SOS㊙ReceiptNumber').value=this.value">
        </div>
        <input id="dp_CCM_Month" value="${month}"><input id="dp_CCM_Year" value="${year}">
        <input id="HidReserveDate"><input id="HidReserveTimeRangeID"><input id="HidLocalCode">
        <div id="div_ClaimsOrderAccountsPayableReserveDate"><div id="div㊙${day}"><table><tr><td>松江本部
          <ul ullocalcode="001"><li>全天 <span timerangeid="slot-1" onclick="selectSlot()">可约</span></li></ul>
        </td></tr></table></div></div>
        <input id="txtEmployeeNo" value="TEST"><input id="txtEmployeeName" value="模拟">
        <label for="bank">教职工银行卡-建设银行</label><input type="checkbox" id="bank" name="chk_SOS_SettlementType">
        <table><tr><td><input name="txt_SOS_STNo" value="TEST"><input name="txt_SOS_STName" value="模拟">
          <input name="txt_SOS_STCardNo" value="test-account"><input name="txt_SOS_STAmount"></td></tr></table>
        <input id="txt_SOS_SettlementAmount" value="142.64">
        <a href="#" onclick="submitOrder(); return false">保存并提交</a>
        <a href="#" id="OrderQuery" onclick="document.querySelector('#query').hidden=false; return false">报销单查询</a>
        <div id="query" hidden><input id="txt_COQ_OrderNo"><input id="txt_COQ_Remark">
          <button onclick="queryOrder()">查询</button>
          <table id="grid_COQ_OrderList"><tr><td><a href="#" onclick="fun_COQ_Print(); return false">打印</a></td></tr></table>
        </div>
        <script>
          const row = ${JSON.stringify(row)};
          let queried = false;
          window.jQuery = () => ({ data: (name) => name === 'kendoGrid'
            ? { dataSource: { view: () => queried ? [row] : [] }, dataItem: () => row } : undefined });
          function selectSlot() {
            document.querySelector('#HidReserveDate').value = '${date}';
            document.querySelector('#HidReserveTimeRangeID').value = 'slot-1';
            document.querySelector('#HidLocalCode').value = '001';
          }
          function fun_COQ_Print() {
            const bytes = Uint8Array.from(atob('${original.toString('base64')}'), (character) => character.charCodeAt(0));
            window.open(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })));
          }
          async function submitOrder() {
            const response = await fetch('/SFP_Claims1Self/COC_ClaimsOrderCreateDaily/Save_DailyOrder', { method: 'POST' });
            if (response.ok && ${popup}) fun_COQ_Print();
          }
          async function queryOrder() {
            const field = document.querySelector('#txt_COQ_OrderNo');
            await noteQuery(field.value);
            queried = true;
          }
        </script>` });
    });
    const page = await context.newPage();
    await page.exposeFunction('noteQuery', (number) => events.push(number ? 'query-number' : 'query-reason'));
    await page.goto('https://cwc.suibe.edu.cn/SFP_Claims1Self');
    const control = { autoSubmit: true, progress: { booking: { orderId, projectId, expenseLabel: '模拟科目' }, submission: { state: 'not_started' } } };
    const options = {
      plan, control, sourceRoot: directory, openSession: async () => ({ page }), signal: AbortSignal.timeout(40000),
      validate: async () => {}, persist: async () => {},
      async record() { events.push('record'); },
      log(step) { if (step === '保存报销单 PDF') events.push('save'); },
      selectPrintQueue: async () => 'fixture-printer',
      async printPdf(path, queue) {
        assert.equal(queue, 'fixture-printer');
        assert.deepEqual(await readFile(path), original);
        assert.equal(control.progress.booking.printState, 'attempted');
        events.push('print');
        return 'fixture-printer-12';
      },
    };
    assert.equal(await executeDailySchoolBooking(options), 'booked');
    assert.deepEqual(events, [...(popup ? [] : ['query-reason']), 'save', 'print', 'query-number', 'record']);
    assert.equal(submissions, 1);
    assert.equal(control.progress.submission.financeFormId, financeFormId);
    assert.equal(control.progress.booking.printJobId, 'fixture-printer-12');
    control.progress.submission = { state: 'attempted' };
    events.length = 0;
    assert.equal(await executeDailySchoolBooking(options), 'booked');
    assert.deepEqual(events, ['query-number', 'record']);
    assert.equal(submissions, 1);
  });
});

test('school payroll reads the reason from its original draft when the summary omits it and resumes receipt lookup', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const project = projectFixture[0];
  const payroll = {
    category: '校外人员劳务费', grantType: '非科研项目', reason: '整理课程访谈材料', totalCny: 12345,
    people: [{ name: '模拟同名', position: '副高', purpose: '为课程案例校对访谈转录稿', hours: '1.5', amountCny: 12345, expenseItem: '讲座费' }],
  };
  const plan = { project, reason: payroll.reason, totalCny: payroll.totalCny, peopleCount: 1, fingerprint: 'revision', signer: { name: '示例教学加签人', employeeNo: '980001' } };
  const school = 'https://cwc.suibe.edu.cn';
  let creates = 0;
  let submissions = 0;
  let schoolReason = '另一笔事项';
  await context.route('**/*', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/SFP_SalarySelf/SalaryDeclare/op_CreatDeclare') {
      creates += 1;
      return route.fulfill({ json: { Errors: { rs: { errors: ['Successed'] } }, Data: ['draft-001'] } });
    }
    if (pathname === '/SFP_SalarySelf/SalaryDeclare/GetSalaryDeclareEn') {
      const id = new URLSearchParams(route.request().postData()).get('p_DeclareID');
      return route.fulfill({ json: { DeclareID: id, DeclareBillNo: 'PAYROLL-TEST-001', ProjectCode: project.projectNo, State: 6 } });
    }
    if (pathname === '/SFP_SalarySelf/SalaryDeclareDetail/Ctrl_SalaryDeclare_DetailOperate') {
      assert.equal(new URLSearchParams(route.request().postData()).get('p_DeclareID'), 'draft-001');
      return route.fulfill({ contentType: 'text/html; charset=utf-8',
        body: '<input id="Hid_DeclareID" value="draft-001"><table><tr><th>发放内容：</th><td>' + schoolReason +
          '</td></tr></table><span id="GrantNum">1</span><span id="ShouldAmount">123.45</span>' });
    }
    if (pathname === '/SFP_SalarySelf/SalaryDeclareDetail/SaveThreeApprover') {
      const saved = new URLSearchParams(route.request().postData());
      assert.equal(saved.get('p_en[0].DeclareID'), 'draft-001');
      assert.equal(saved.get('p_en[0].PersonnelID'), 'reviewer-person-01');
      return route.fulfill({ json: { Successed: true } });
    }
    if (pathname === '/SFP_SalarySelf/SalaryDeclareDetail/Ctrl_ThreeApprover') {
      assert.equal(new URL(route.request().url()).searchParams.get('p_DeclareID'), 'draft-001');
      return route.fulfill({ contentType: 'text/html; charset=utf-8',
        body: '<div id="ReviewerMultiplePerson"><ul><li><span id="selected">980001-示例教学加签人</span></li></ul></div>' });
    }
    if (pathname === '/SFP_SalarySelf/SalaryDeclareDetail/SubmitSalaryDeclareDetail') {
      submissions += 1;
      const submitted = new URLSearchParams(route.request().postData());
      assert.equal(submitted.get('p_DeclareID'), 'draft-001');
      assert.equal(submitted.get('p_IsThree'), 'true');
      return route.fulfill({ json: { Errors: { rs: { errors: ['Successed'] } } } });
    }
    if (pathname !== '/SFP_SalarySelf/SalaryDeclareManagement/') return route.abort();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAYROLL_HTML
      .replace('FIXTURE_PROJECT', JSON.stringify(project.projectNo)) });
  });
  const page = await context.newPage();
  await page.goto(school + '/SFP_SalarySelf/SalaryDeclareManagement/');
  const control = { progress: { submission: { state: 'not_started' } }, autoSubmit: true };
  let records = 0;
  let pauseOnApproval = true;
  const remembered = [];
  const options = {
    plan, payroll, control, openSession: async () => ({ page }), signal: AbortSignal.timeout(28000), lookupKey: 'b'.repeat(64),
    validate: async () => {}, persist: async () => {}, log: () => {}, rememberRecipient: async (person) => remembered.push(person),
    stage(step) { if (pauseOnApproval && step === '正在确认加签') control.skipSubmit = true; },
    record: async () => { records += 1; },
    ask: async (_, { choices }) => {
      assert.match(choices[0].label, /0001/);
      assert.match(choices[1].label, /0002/);
      return '2';
    },
  };
  await assert.rejects(() => executeSchoolPayroll(options), /发放内容与本机事项不一致/);
  assert.equal(control.progress.submission.state, 'not_started');
  assert.equal(creates, 1);
  assert.deepEqual(await page.evaluate(() => window.fixture.entries), []);
  schoolReason = payroll.reason;
  assert.equal(await executeSchoolPayroll(options), 'preview');
  assert.equal(control.progress.submission.state, 'not_started');
  assert.equal(control.progress.payroll.approvalAttemptedAt, undefined);
  assert.equal(submissions, 0);
  pauseOnApproval = false;
  control.skipSubmit = false;
  await assert.rejects(() => executeSchoolPayroll(options), { code: 'PAYROLL_RECEIPT_PENDING' });
  assert.equal(control.progress.submission.state, 'attempted');
  assert.equal(control.progress.payroll.declareId, 'draft-001');
  assert.equal(records, 0);
  assert.equal(creates, 1);
  assert.deepEqual(remembered.map(({ identityTail }) => identityTail), ['0002']);
  assert.deepEqual(await page.evaluate(() => window.fixture.entries), [{
    Code: 'EXT0002', Name: '模拟同名', OrgName: '部门二', Position: '副高', Purpose: payroll.people[0].purpose, Hours: '1.5', Amount: '', Lecture: '123.45',
  }]);
  assert.equal(await page.evaluate(() => window.fixture.submitClicks), 2);
  assert.equal(submissions, 1);
  assert.ok(control.progress.payroll.approvalAttemptedAt);
  control.progress.submission = { state: 'not_started' };
  await assert.rejects(() => executeSchoolPayroll(options), { code: 'PAYROLL_RECEIPT_PENDING' });
  assert.equal(await page.evaluate(() => window.fixture.submitClicks), 2);
  await page.evaluate(() => { window.fixture.declaration.State = 1; });
  delete control.progress.payroll.approvalAttemptedAt;
  delete control.progress.payroll.signerCode;
  assert.equal(await executeSchoolPayroll(options), 'declared');
  assert.equal(control.progress.submission.financeFormId, 'PAYROLL-TEST-001');
  assert.equal(records, 1);
  assert.equal(creates, 1);
  assert.equal(await page.evaluate(() => window.fixture.submitClicks), 2);
  assert.equal(submissions, 1);
  const status = await readSchoolPayrollStates(page.mainFrame(), [
    { runId: 'original', declareId: 'draft-001', financeFormId: 'PAYROLL-TEST-001', projectNo: project.projectNo },
    { runId: 'different-bill', declareId: 'draft-001', financeFormId: 'PAYROLL-TEST-OTHER', projectNo: project.projectNo },
    { runId: 'different-project', declareId: 'draft-001', financeFormId: 'PAYROLL-TEST-001', projectNo: 'OTHER' },
  ], options.signal);
  assert.deepEqual(status.map(({ runId, state, label }) => [runId, state, label]), [['original', 'excluded', '财务处审核驳回']]);
});

const PAYROLL_HTML = `<!doctype html><meta charset="utf-8">
  <style>.k-grid { min-height: 32px; }</style>
  <a href="#" class="linkTab">校外人员劳务费</a><a href="#">薪资申报</a>
  <a href="#" onclick="document.querySelector('#temp_div_CreatDeclare').hidden=false">创建</a>
  <input id="Hid_Period" type="hidden" value="period-001"><input id="Hid_SubmitAuditType" type="hidden" value="0">
  <div id="temp_div_CreatDeclare" hidden>
    <input type="hidden" id="Dp_Project"><input type="hidden" id="Dp_Dept"><input type="hidden" id="Dp_GrantClass"><input type="hidden" id="Dp_Controls">
    <input id="txt_GrantContent"><span id="s_BudgetBalance">2000.00</span><a href="#" onclick="SavelDeclare();">保存</a>
  </div>
  <div id="div_SalaryDeclareDetail"></div>
  <script>
    const project = FIXTURE_PROJECT;
    const fixture = window.fixture = { entries: [], declaration: {}, submitClicks: 0 };
    const people = [
      { Code:'EXT0001', Name:'模拟同名', OrgName:'部门一' },
      { Code:'EXT0002', Name:'模拟同名', OrgName:'部门二' },
    ];
    const names = [['Code','工号/人员号'], ['Name','姓名'], ['OrgName','所属部门']];
    const detailFields = [...names, ['Position','职称职务'], ['Purpose','用途'], ['Hours','工作学时'], ['Amount','其他劳务费'], ['Lecture','讲座费']];
    const widgets = new Map();
    window.jQuery = (element) => ({ data: () => widgets.get(typeof element === 'string' ? document.querySelector(element) : element) });
    for (const [id, text] of Object.entries({ Dp_Project: project + ' 模拟项目', Dp_Dept:'模拟部门', Dp_GrantClass:'非科研项目', Dp_Controls:'02-劳务费' })) {
      const element = document.getElementById(id);
      const options = [{ text, value: 'code-' + id }];
      if (id === 'Dp_Dept') element.value = options[0].value;
      widgets.set(element, { options: {dataTextField:'text',dataValueField:'value'}, dataSource: {view: () => options, read: () => Promise.resolve()},
        text: () => text, dataItem: () => options[0], trigger: () => {},
        value(v) { if (v !== undefined) element.value = v; return element.value; } });
    }
    function grid(element, columns, rows, render) {
      let listener;
      function update(newRows) {
        rows = newRows;
        element.querySelector('tbody').innerHTML = rows.map(render).join('');
        const locked = element.querySelector('.k-grid-content-locked tbody');
        if (locked) locked.innerHTML = rows.map((_, i) => '<tr data-uid="d'+i+'"><td>姓名</td></tr>').join('');
        if (listener) { const notify = listener; listener = null; notify(); }
      }
      widgets.set(element, {
        columns: columns.map(([field, title]) => ({ field, title })),
        dataSource: { total: () => rows.length, view: () => rows },
        tbody: { find: (selector) => element.querySelector('tbody').querySelectorAll(selector) },
        dataItem: (row) => rows[Number(row.dataset.uid.slice(1))],
        one: (_, handler) => { listener = handler; },
      });
      update(rows);
      return update;
    }
    async function SavelDeclare() {
      const response = await fetch('/SFP_SalarySelf/SalaryDeclare/op_CreatDeclare', {method:'POST'});
      const reply = await response.json();
      fixture.declaration = { DeclareID:reply.Data[0], DeclareBillNo:'PAYROLL-TEST-001', LatoryID:'fixture-latory', ProjectCode:project, GrantContent:document.getElementById('txt_GrantContent').value, State:0 };
      document.getElementById('temp_div_CreatDeclare').hidden = true;
      document.body.insertAdjacentHTML('beforeend', '<div class="k-window" id="create-success"><p>创建成功!是否现在开始编辑?</p><button onclick="document.getElementById(&quot;create-success&quot;).remove();JumpSalaryDetailDeclare(&quot;draft-001&quot;)">确定</button></div>');
    }
    function execAjax(controller, action, data, callback) {
      if (controller === 'SalaryDeclare' && action === 'GetSalaryDeclareEn' && data.p_DeclareID === fixture.declaration.DeclareID) callback({ ...fixture.declaration, GrantContent:null, GrantNum:0, ShouldAmount:0 });
    }
    function JumpSalaryDetailDeclare(id) {
      if (id !== fixture.declaration.DeclareID) throw Error('wrong declaration');
      document.getElementById('div_SalaryDeclareDetail').innerHTML =
        '<input type="hidden" id="Hid_DeclareID" value="'+id+'"><button>返回</button><button onclick="showChooser(false)">添加人员</button><button onclick="edit()">行编辑</button>'+
        '<div class="k-grid" id="detailGrid"><table><tbody></tbody></table><div class="k-grid-content-locked"><table><tbody></tbody></table></div></div>'+
        '<label><input type="checkbox" id="chkIsThree">线上审批</label>'+
        '<button id="btnSubmit" onclick="SubmitSalaryDeclare()">提交</button>';
      window.renderRows = grid(document.getElementById('detailGrid'), detailFields, fixture.entries, (item, i) =>
        '<tr data-uid="d'+i+'"><td><input type="checkbox"></td>'+detailFields.map(([field]) => '<td>'+(item[field] || '')+'</td>').join('')+'</tr>');
      widgets.get(document.getElementById('detailGrid')).columns.unshift({ title:'选择' });
    }
    function showChooser(signer) {
      const dialog = document.createElement('div');
      dialog.id = 'temp_div_SelectPerson';
      dialog.className = 'k-window-content';
      dialog.innerHTML = '<input id="'+(signer?'txt_EmployeeCode':'txt_Para')+'"><input aria-label="部门筛选"><a href="#">查 询</a><div class="k-grid" id="pickerGrid"><table><tbody></tbody></table></div>'+(signer?'<a href="#" onclick="SaveMultiSelectReviewer()">保 存</a>':'');
      document.body.append(dialog);
      const rows = signer ? [{ Code:'980001', Name:'示例教学加签人', OrgName:'模拟学院', PersonnelID:'reviewer-person-01' }] : people;
      const update = grid(dialog.querySelector('.k-grid'), names, [], (item, i) =>
        '<tr data-uid="p'+i+'"><td>'+item.Code+'</td><td>'+item.Name+'</td><td>'+item.OrgName+'</td><td>'+(signer?'<input type="checkbox" name="chkReviewer" value="'+item.PersonnelID+'" title="0" codename="'+item.Code+'-'+item.Name+'">':'<input type="button" value="选择">')+'</td></tr>');
      dialog.querySelector('a').onclick = () => update(rows.filter((item) => [item.Name,item.Code].includes(dialog.querySelector('input').value)));
      dialog.onclick = (event) => {
        if (event.target.value !== '选择') return;
        const item = rows[Number(event.target.closest('tr').dataset.uid.slice(1))];
        fixture.entries.push({ ...item });
        window.renderRows(fixture.entries);
        dialog.remove();
      };
    }
    function fun_ReviewerMultiplePerson() { showChooser(true); }
    function SaveMultiSelectReviewer() {
      const selected = document.querySelector('input[name="chkReviewer"]:checked');
      if (!selected) throw Error('missing reviewer');
      document.querySelector('#ReviewerMultiplePerson ul').innerHTML = '<li><span id="0|'+selected.value+'|reviewer-01|person-01">'+selected.getAttribute('codename')+'</span></li>';
      selected.closest('.k-window-content').remove();
    }
    function edit() {
      const selected = document.querySelector('#detailGrid input:checked').closest('tr');
      for (const [index, [field]] of detailFields.entries()) {
        if (index < names.length) continue;
        selected.cells[index+1].innerHTML = field === 'Position' ? '<select name="Position"><option>正高</option><option>副高</option><option>其他</option></select>' : '<input name="'+field+'">';
      }
      const cell = selected.insertCell();
      cell.innerHTML = '<button>保存</button>';
      cell.querySelector('button').onclick = () => {
        const item = fixture.entries[Number(selected.dataset.uid.slice(1))];
        selected.querySelectorAll('[name]').forEach((input) => { item[input.name] = input.value; });
        window.renderRows(fixture.entries);
      };
    }
    function SubmitSalaryDeclare() {
      document.body.insertAdjacentHTML('beforeend','<div class="k-window" id="online-dialog"><div class="k-window-content" id="extOkCancelDialog"><p>&nbsp;&nbsp;&nbsp;确认走线上审批吗?</p></div><div class="k-ext-dialog-buttons"><button onclick="showApproval()">确 定</button></div></div>');
    }
    function showApproval() {
      document.getElementById('online-dialog').remove();
      document.body.insertAdjacentHTML('beforeend','<div class="k-window-content" id="temp_div_ThreeApprover"><input id="HidReviewerID" type="hidden" value="reviewer-01"><div id="ReviewerMultiplePerson"><ul></ul></div><a href="#" class="k-i-search" onclick="fun_ReviewerMultiplePerson(&#39;reviewer-01&#39;)">⌕</a><button onclick="ThreeApprover()">确定</button></div>');
    }
    async function ThreeApprover() {
      fixture.submitClicks += 1;
      const selected = document.querySelector('#ReviewerMultiplePerson li span');
      const [category, personnelId, reviewerId] = selected.id.split('|');
      const online = document.getElementById('chkIsThree').checked;
      const save = await fetch('/SFP_SalarySelf/SalaryDeclareDetail/SaveThreeApprover',{method:'POST',
        body:new URLSearchParams({'p_en[0].DeclareID':fixture.declaration.DeclareID,'p_en[0].ReviewerID':reviewerId,
          'p_en[0].PersonCategory':category,'p_en[0].PersonnelID':personnelId})});
      if (!save.ok || !(await save.json()).Successed) return;
      document.getElementById('temp_div_ThreeApprover').remove();
      const response = await fetch('/SFP_SalarySelf/SalaryDeclareDetail/SubmitSalaryDeclareDetail',{method:'POST',
        body:new URLSearchParams({p_DeclareID:fixture.declaration.DeclareID,p_IsThree:String(online)})});
      if (!response.ok) return;
      fixture.declaration.IsThree = online;
      fixture.declaration.ThreeApprover = selected.textContent.split('-')[0];
      fixture.declaration.ThreeState = 2;
      fixture.declaration.GrantNum = fixture.entries.length;
      fixture.declaration.ShouldAmount = fixture.entries.reduce((sum, item) => sum + Number(item.Amount) + Number(item.Lecture), 0);
    }
  </script>`;

test('BOC evidence selects the dated currency and the middle column rather than the sale price', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(`<table><tr><th>货币名称</th><th>现汇卖出价</th><th>中行折算价</th><th>发布时间</th></tr>
    <tr><td>美元</td><td>711.90</td><td>709.81</td><td>2026.09.24 11:30:00</td></tr>
    <tr><td>美元</td><td>713.11</td><td>712.50</td><td>2026.09.25 10:00:00</td></tr>
    <tr><td>欧元</td><td>802.17</td><td>797.21</td><td>2026.09.24 13:00:00</td></tr>
    <tr><td>美元</td><td>711.92</td><td>710.22</td><td>2026/09/24 12:00:00</td></tr></table>`);
  assert.deepEqual(await page.evaluate(officialQuote, { currencyName: '美元', date: '2026-09-24', highlight: true }), { ratePer100: '710.22', quotedAt: '2026-09-24 12:00:00' });
  assert.equal(await page.locator('td[style]').innerText(), '710.22');
  assert.equal(await page.evaluate(officialQuote, { currencyName: '美元', date: '2026-09-23' }), null);
});

test('the foreign claim detail updates its total after saving the selected quote', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  let saved = false;
  const date = '2026-09-24';
  const currency = 'EUR';
  const key = `${date}-${currency}`;
  const native = { currency, minor: 1200, digits: 2 };
  const quote = { date, currency, key, quotedAt: `${date} 12:00:00`, ratePer100: '801.34' };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/folders') return route.fulfill({ json: { sourceRoot: uiSourceRoot, folders: [], claims: [{ path: uiGroupKey, groupId: uiPlan().groupId, label: uiFolder, sourceFolders: [uiFolder], subject: '境外软件订阅', fileCount: 2, reimbursed: false }] } });
    if (url.pathname === '/api/plans') {
      const amount = saved ? 9616 : null;
      const row = { invoiceNumber: 'FX-TEST', date, foreignMoney: native, invoiceAmountCny: amount, paidAmountCny: amount, reimbursementAmountCny: amount, fx: saved ? [{ native, cny: amount, quoteKey: key }] : [] };
      return route.fulfill({ json: { plan: { ...uiPlan(), reimbursementRoute: 'legacy', foreignClaim: true, rows: [row], invoiceTotalCny: amount, paidTotalCny: amount, totalCny: amount, fxNeeded: saved ? [] : [{ date, currency }], fxQuotes: saved ? [quote] : [] } } });
    }
    if (url.pathname === `/api/plans/${uiPlan().id}/fx-quote`) {
      assert.deepEqual(route.request().postDataJSON(), { date, currency });
      saved = true;
      return route.fulfill({ json: quote });
    }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${origin}/runner`);
  await page.locator('.row-state', { hasText: '待补中行牌价' }).waitFor();
  await page.getByRole('button', { name: '详情', exact: true }).click();
  await page.getByText('EUR 12.00', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查询并保存截图' }).click();
  const download = page.getByRole('link', { name: '下载中行牌价截图' });
  await download.waitFor();
  assert.equal(await download.getAttribute('href'), `/api/plans/${uiPlan().id}/fx-quote/${key}`);
  assert.match(await page.locator('.metrics').innerText(), /核定报销\s*¥96\.16/);
});

test('a recognized payment can be linked before funding allocation and stays visible after refresh', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const match = { funding: '教学', allocations: projectFixture.map((project) => ({ ...project, amountCny: null })) };
  const claim = { path: uiGroupKey, groupId: uiPlan().groupId, label: uiFolder, sourceFolders: [uiFolder], subject: '办公用品', fileCount: 2, match };
  const source = { path: uiFolder, fileCount: 2, claimKey: uiGroupKey, claimLabel: claim.label };
  const evidence = { name: '模拟银行明细.png', amountCny: 9876, date: '2026-07-08' };
  let saved = false;
  let executions = 0;
  const planFor = (folder) => {
    const linked = saved && folder === uiGroupKey;
    return {
      ...uiPlan(), folder, sourceFolders: folder === uiGroupKey ? [uiFolder] : undefined,
      project: projectFixture[0], reimbursementRoute: 'smart', status: 'blocked', reason,
      blockers: [linked ? '请填写每个手动分配项目的金额' : '已识别付款 98.76 元，请确认对应发票'],
      rows: [{ invoiceNumber: number, invoiceAmountCny: 10000, invoiceFile: '发票.pdf',
        paymentFiles: linked ? [evidence.name] : [], paidAmountCny: linked ? 9876 : null }],
      paymentCandidates: [evidence], totalCny: linked ? 9876 : null, paidTotalCny: linked ? 9876 : null,
    };
  };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/folders') return route.fulfill({ json: { sourceRoot: uiSourceRoot, folders: [source], claims: [claim] } });
    if (url.pathname === '/api/plans') {
      const { folder } = route.request().postDataJSON();
      return route.fulfill({ json: { plan: planFor(folder), match } });
    }
    if (url.pathname === `/api/plans/${uiPlan().id}/confirmations`) {
      assert.deepEqual(route.request().postDataJSON().paymentLinks, { [number]: [evidence.name] });
      saved = true;
      return route.fulfill({ json: { plan: planFor(uiGroupKey) } });
    }
    if (url.pathname === '/api/batch-runs' && route.request().method() === 'POST') {
      executions += 1;
      return route.fulfill({ status: 409, json: { error: '材料待核对' } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${origin}/runner`);
  const sourceRow = page.locator('.source-row', { hasText: uiFolder });
  await sourceRow.getByText(/识别到付款 ¥98\.76 · 待确认对应关系/).waitFor();
  await page.locator('.allocation-status', { hasText: '请先核对发票和付款并保存' }).waitFor();
  await page.locator('.row-select').check();
  await page.locator('#executeSelected').click();
  assert.match(await page.locator('#executionStatus').innerText(), /已识别付款 98\.76 元/);
  await page.locator('#executionDetails', { hasText: '核对发票和付款' }).click();
  assert.match(await page.locator('.metrics').innerText(), /已识别付款\s*¥98\.76/);
  await page.locator('#paymentReview').getByRole('checkbox', { name: /模拟银行明细/ }).check();
  await page.getByRole('button', { name: '保存核对结果', exact: true }).click();
  await page.locator('#materialStatus', { hasText: '核定报销 ¥98.76' }).waitFor();
  await page.locator('#closeDetail').click();
  await page.locator('#refreshFolders').click();
  await page.locator('#folderRefreshStatus', { hasText: '刷新完成' }).waitFor();
  assert.match(await sourceRow.innerText(), /核定 ¥98\.76/);
  assert.equal(await page.locator('[data-claim-total]').innerText(), '¥98.76');
  assert.equal(executions, 0);
});

test('registering a manual school receipt clears a stale batch failure label', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const createdAt = '2026-07-08T02:00:00Z';
  const plan = { ...uiPlan(), reimbursementRoute: 'smart' };
  const run = { id: 'test-receipt-run', plan, status: 'error', error: '支付未完成', canEndDraft: true,
    createdAt, updatedAt: createdAt, events: [], messages: [] };
  let payload;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/folders') return route.fulfill({ json: { sourceRoot: uiSourceRoot, folders: [], claims: [] } });
    if (url.pathname === '/api/runs') return route.fulfill({ json: { runs: [run], blockingRunId: run.canEndDraft ? run.id : null } });
    if (url.pathname === '/api/batches') return route.fulfill({ json: {
      batches: [{ id: 'test-manual-batch', status: 'error', currentIndex: 0, currentRunId: run.id, createdAt, runs: [run] }],
    } });
    if (url.pathname === `/api/runs/${run.id}/resolution`) {
      payload = route.request().postDataJSON();
      Object.assign(run, { status: 'completed', canEndDraft: false, error: null });
      return route.fulfill({ json: { run } });
    }
    assert.ok(!url.pathname.endsWith('/instructions'));
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${origin}/runner`);
  await page.locator('#viewBlockingRun').click();
  await page.locator('#runStatus', { hasText: '批次失败' }).waitFor();
  page.once('dialog', (dialog) => dialog.accept('TEST-RECEIPT-001'));
  await page.getByRole('button', { name: '登记手动提交', exact: true }).click();
  await page.locator('#runStatus', { hasText: '批次已完成' }).waitFor();
  assert.deepEqual(payload, { confirmed: true, resolution: 'submitted', financeFormId: 'TEST-RECEIPT-001' });
  await page.locator('#blockingRunNotice').waitFor({ state: 'hidden' });
});

test('the worklist filters by reimbursement system and selects smart and daily offline claims for a batch', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const match = { ...projectFixture[1], funding: '教学' };
  const definitions = [
    { label: '人民币结算', subject: '境外软件订阅', route: 'smart' },
    { label: '外币实付', subject: '境外软件订阅', route: 'legacy' },
    { label: '劳务发放', subject: '劳务费', route: 'labor' },
    { label: '混合付款', subject: 'AI服务', route: 'split' },
  ];
  const claims = definitions.map(({ label, subject }, index) => ({
    path: `@事项/${index + 1}`, groupId: String(index + 1), label, subject,
    sourceFolders: [label], fileCount: 1, reimbursed: false, match,
  }));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/school-finance/check') {
      assert.equal(route.request().postDataJSON().kind, 'labor');
      return route.fulfill({ json: { status: 'form_verified', computer: '本机', message: '已核对空白申报抬头。' } });
    }
    if (url.pathname === '/api/projects') return route.fulfill({ json: {
      projects: [{ ...projectFixture[0], laborBalanceCny: 25000 }, projectFixture[1]],
      syncedAt: '2026-11-11T08:27:00Z',
    } });
    if (url.pathname === '/api/folders') return route.fulfill({ json: { sourceRoot: uiSourceRoot, folders: [], claims } });
    if (url.pathname === '/api/plans') {
      const { folder } = route.request().postDataJSON();
      const index = claims.findIndex((item) => item.path === folder);
      const { subject, route: reimbursementRoute } = definitions[index];
      const labor = subject === '劳务费';
      const plan = { ...uiPlan(), folder, subject, reimbursementRoute, project: match };
      if (labor) Object.assign(plan, { rows: [], uploadFiles: [], batches: [], supportingFiles: ['劳务发放清单.xlsx'], totalCny: null });
      return route.fulfill({ json: { plan, match } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${origin}/runner`);
  const row = (label) => page.locator('.folder-row').filter({ has: page.getByText(label, { exact: true }) });
  await row('混合付款').getByText('请按结算方式拆分').waitFor();
  assert.equal(await row('人民币结算').getByRole('checkbox').isEnabled(), true);
  await row('人民币结算').getByRole('button', { name: '匹配经费 人民币结算' }).click();
  const budget = page.locator('.project-match', { hasText: '模拟科研经费' });
  assert.equal(await budget.locator('.project-balance').innerText(), '可用金额 ¥0.00');
  assert.equal(await budget.locator('.project-labor').innerText(), '其中劳务费 待查询');
  const teaching = page.locator('.project-match', { hasText: '模拟教学经费' });
  assert.equal(await teaching.locator('.project-balance').innerText(), '可用金额 ¥1,000.00');
  assert.equal(await teaching.locator('.project-labor').innerText(), '其中劳务费 ¥250.00');
  const amountStyles = await teaching.locator('.project-money span').evaluateAll((elements) => elements.map((element) => {
    const { fontSize, fontWeight } = getComputedStyle(element);
    return { fontSize, fontWeight };
  }));
  assert.deepEqual(amountStyles, [{ fontSize: '12px', fontWeight: '400' }, { fontSize: '12px', fontWeight: '400' }]);
  assert.match(await budget.locator('.match-shortage').innerText(), /差 ¥98\.76/);
  assert.equal(await row('外币实付').getByRole('checkbox').isEnabled(), true);
  for (const label of ['劳务发放', '混合付款']) {
    assert.equal(await row(label).getByRole('checkbox').isDisabled(), true);
  }
  await page.locator('#selectAll').click();
  assert.equal(await page.locator('.row-select:checked').count(), 2);
  assert.equal(await row('人民币结算').getByRole('checkbox').isChecked(), true);
  await page.getByLabel('筛选办理系统').selectOption('legacy');
  assert.equal(await page.locator('.folder-row').count(), 1);
  await row('外币实付').getByRole('button', { name: '匹配经费 外币实付' }).click();
  assert.equal(await teaching.locator('.project-balance').innerText(), '可用金额 ¥1,000.00');
  assert.equal(await budget.locator('.match-shortage').count(), 0);
  await page.getByLabel('筛选办理系统').selectOption('labor');
  assert.equal(await page.locator('.folder-row').count(), 1);
  await page.getByRole('button', { name: '核对学校填报入口' }).click();
  await page.getByText('本机 · 已核对空白申报抬头。', { exact: true }).waitFor();
  await row('劳务发放').getByRole('button', { name: '匹配经费 劳务发放' }).click();
  assert.equal(await teaching.locator('.project-balance').innerText(), '可用金额 ¥1,000.00');
  assert.equal(await teaching.locator('.project-labor').innerText(), '其中劳务费 ¥250.00');
  assert.equal(await budget.locator('.project-labor').innerText(), '其中劳务费 待查询');
  assert.equal(await budget.locator('.match-shortage').count(), 0);
  assert.match(await page.getByRole('link', { name: '打开薪酬申报' }).getAttribute('href'), /SalaryDeclare%2FExternalLogin\.aspx/);
  await row('劳务发放').getByRole('button', { name: '详情' }).click();
  await page.locator('#detailContent').getByText('劳务发放清单.xlsx', { exact: true }).waitFor();
  assert.equal(await page.locator('#detailContent').getByLabel('报销科目').inputValue(), '劳务费');
  assert.equal(await page.locator('#detailSignerPicker select').count(), 0);
});

test('the Didi worklist saves the cap first and sends its right-column match for execution', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const id = '17171717-1717-4171-8171-171717171717';
  const path = '@事项/' + id;
  const project = projectFixture[0];
  const projectSigner = { name: '模拟默认加签人', employeeNo: 'TEST-911' };
  const override = { name: '模拟本笔加签人', employeeNo: 'TEST-912' };
  let item;
  let execution;
  await context.route('**/*', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/projects') return route.fulfill({ json: { projects: [project] } });
    if (pathname === '/api/folders') return route.fulfill({ json: {
      sourceRoot: uiSourceRoot, folders: [], claims: item ? [item] : [], signerRoster: [projectSigner, override],
    } });
    if (pathname === '/api/didi-claims') {
      assert.deepEqual(route.request().postDataJSON(), {
        sourceRoot: uiSourceRoot, budget: '150.25', signerOverride: null,
      });
      item = { path, groupId: id, label: '贸大出行', subject: '贸大出行', match: null, sourceFolders: [], didi: { budgetCny: 15025, blocker: '请在右栏匹配一个经费项目', revision: 'initial' } };
      return route.fulfill({ status: 201, json: { id, key: path } });
    }
    if (pathname === '/api/didi-claims/' + id) {
      assert.deepEqual(route.request().postDataJSON(), {
        sourceRoot: uiSourceRoot, budget: '150.25', revision: 'confirmed', signerOverride: override,
      });
      item.didi = { ...item.didi, revision: 'override', signerOverride: override, signer: override };
      return route.fulfill({ json: { id, key: path } });
    }
    if (pathname === '/api/project-match') {
      const match = route.request().postDataJSON().match;
      assert.equal(match.projectNo, project.projectNo);
      item = { ...item, match, didi: {
        ...item.didi, blocker: '请写清用车事由并保存', revision: 'matched',
        signerDefault: projectSigner, signerDefaultSource: 'project', signer: projectSigner,
      } };
      return route.fulfill({ json: { match } });
    }
    if (pathname === '/api/claim-reason') {
      const { reason, explicit } = route.request().postDataJSON();
      item = { ...item, reasonDraft: reason, reasonSaved: explicit === true, didi: { ...item.didi, blocker: explicit ? '' : '请写清用车事由并保存', revision: explicit ? 'confirmed' : 'draft' } };
      return route.fulfill({ json: { reasonDraft: reason, reasonSaved: item.reasonSaved, ...item.didi } });
    }
    if (pathname === '/api/batch-runs') {
      execution = route.request().postDataJSON();
      return route.fulfill({ status: 202, json: { batch: { id: 'didi-test-batch', status: 'running', runs: [{
        id: 'didi-test-run', status: 'running', events: [], messages: [], plan: { folder: path, displayName: item.reasonDraft, didi: item.didi, reimbursementRoute: 'smart' },
      }] } } });
    }
    if (pathname === '/api/plans') assert.fail('the Didi card must not analyze local files');
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(origin + '/runner');
  await page.getByRole('button', { name: '新增贸大出行' }).click();
  const form = page.getByRole('dialog', { name: '新增贸大出行' });
  assert.equal(await form.getByLabel('经费项目').count(), 0);
  await form.getByLabel('预算上限（元）').fill('150.25');
  await form.getByRole('button', { name: '保存预算' }).click();
  const row = page.locator('#folderRows .folder-row');
  await row.getByText('预算上限', { exact: true }).waitFor();
  await page.getByRole('button', { name: '匹配 ' + project.projectName, exact: true }).click();
  await row.locator('.folder-project', { hasText: project.projectName }).waitFor();
  await row.getByRole('textbox', { name: /报销事由/ }).fill('走访金融实训合作企业的用车费用');
  await row.getByRole('button', { name: '保存事由' }).click();
  await row.getByText('可执行', { exact: true }).waitFor();
  await row.getByRole('button', { name: '详情', exact: true }).click();
  const details = page.getByRole('dialog', { name: '贸大出行详情' });
  const didiSigner = details.getByRole('combobox', { name: '本笔加签人', exact: true });
  assert.match(await didiSigner.locator('option:checked').textContent(), /项目默认 · 模拟默认加签人/);
  await didiSigner.selectOption({ label: override.name + ' · ' + override.employeeNo });
  await details.getByRole('button', { name: '保存详情' }).click();
  await page.getByText('贸大出行详情已更新。', { exact: true }).waitFor();
  await row.getByRole('checkbox', { name: '执行 贸大出行' }).check();
  await page.getByRole('button', { name: '填报选中项', exact: true }).click();
  await page.getByText(/批次已启动，共 1 笔/).waitFor();
  assert.deepEqual(execution, { entries: [{ didiId: id, revision: 'override' }] });
});

test('a payroll declaration pauses for a choice between school results with the same name', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const project = projectFixture[0];
  const key = '12345678-1234-4123-8123-123456789012';
  const category = '学生劳务费';
  const results = ['0123', '5678'].map((identityTail, index) => ({
    key: String(index + 1).repeat(64), name: '模拟同名', identityTail, organization: '学院' + (index + 1), category, source: 'school',
  }));
  let confirmed = [];
  let draft;
  let match;
  let execution;
  await context.route('**/*', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/projects') return route.fulfill({ json: { projects: [project] } });
    if (pathname === '/api/folders') return route.fulfill({ json: {
      sourceRoot: uiSourceRoot, folders: [], payrollCategories: [category, '校外人员劳务费'],
      payrollPositions: ['正高', '副高', '其他'],
      payrollExpenseItems: ['其他劳务费', '讲座费'],
      payrollSignerNames: { 科研项目: '示例科研加签人', 非科研项目: '示例教学加签人' },
      signerRoster: [uiTeachingSigner, { name: '共享名单测试人', employeeNo: '' }],
      claims: draft ? [{ path: '@事项/' + key, groupId: key, label: draft.reason, subject: '劳务费', match,
        payroll: { category: draft.category, peopleCount: 1, totalCny: 12345, revision: 'revision', blocker: match ? '' : '请在右栏匹配薪酬申报的经费项目。' } }] : [],
    } });
    if (pathname === '/api/project-match') {
      match = route.request().postDataJSON().match;
      return route.fulfill({ json: { match } });
    }
    if (pathname === '/api/payroll-people') return route.fulfill({ json: { sourceRoot: uiSourceRoot, people: confirmed, historyAvailable: true, schoolSearch: true } });
    if (pathname === '/api/payroll-people/search') return route.fulfill({ json: { people: results, complete: true } });
    if (pathname === '/api/payroll-people/confirm') {
      const { key, name } = route.request().postDataJSON();
      const person = results.find((item) => item.key === key && item.name === name);
      assert.ok(person);
      confirmed = [{ ...person, confirmed: true }];
      return route.fulfill({ json: { person: confirmed[0] } });
    }
    if (pathname === '/api/payroll-claims' && route.request().method() === 'POST') {
      draft = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { id: key, key: '@事项/' + key } });
    }
    if (pathname === '/api/payroll-claims/' + key) return route.fulfill({ json: {
      ...draft, project: match, revision: 'revision', people: [{ ...draft.people[0], amountCny: 12345 }],
    } });
    if (pathname === '/api/batch-runs') {
      execution = route.request().postDataJSON();
      return route.fulfill({ status: 202, json: { batch: {
        id: 'payroll-test-batch', status: 'running', runs: [{
          id: 'payroll-test-run', status: 'running', events: [], messages: [],
          plan: { folder: '@事项/' + key, displayName: draft.reason, totalCny: 12345, reimbursementRoute: 'labor' },
        }],
      } } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(origin + '/runner');
  await page.getByLabel('筛选办理系统').selectOption('labor');
  await page.getByRole('button', { name: '新增薪酬申报' }).click();
  const form = page.getByRole('dialog', { name: '新增薪酬申报' });
  assert.equal(await form.getByLabel('经费项目').count(), 0);
  await form.locator('#payrollCategory').selectOption('校外人员劳务费');
  assert.equal(await form.getByLabel('费用项').inputValue(), '其他劳务费');
  await form.getByLabel('费用项').selectOption('讲座费');
  await form.locator('#payrollCategory').selectOption(category);
  assert.equal(await form.getByLabel('费用项').isVisible(), false);
  assert.equal(await form.getByLabel('发放部门').count(), 0);
  await form.getByLabel('发放类型').fill('科研项目');
  assert.equal(await form.locator('#payrollSigner').innerText(), '示例科研加签人');
  await form.getByLabel('发放类型').fill('非科研项目');
  assert.equal(await form.locator('#payrollSigner').innerText(), '示例教学加签人');
  const payrollSigner = form.getByRole('combobox', { name: '本笔加签人', exact: true });
  await payrollSigner.selectOption({ label: '共享名单测试人' });
  assert.equal(await form.locator('#payrollSigner').innerText(), '共享名单测试人');
  await payrollSigner.selectOption('default');
  await form.getByLabel('发放内容（报销事由）').fill('整理案例访谈记录');
  await form.getByLabel('姓名', { exact: true }).fill('模拟同名');
  await form.getByRole('button', { name: '查学校人员' }).click();
  await form.getByText('有 2 位同名人员，请按尾号和部门选择。').waitFor();
  assert.equal(confirmed.length, 0);
  const options = form.getByLabel('按姓名和尾号选择人员');
  assert.match(await options.innerText(), /0123/);
  assert.match(await options.innerText(), /5678/);
  assert.equal(await options.inputValue(), '');
  await options.selectOption(results[1].key);
  await form.getByText('本机已确认 · 尾号 5678').waitFor();
  await form.getByLabel('职称职务').selectOption('副高');
  await form.getByLabel('应发金额（元）').fill('123.45');
  await form.getByLabel('用途', { exact: true }).fill('整理案例访谈记录并核对问卷编码');
  assert.match(await form.locator('#payrollTotal').innerText(), /123\.45/);
  await form.getByRole('button', { name: '保存申报' }).click();
  await page.getByText('请在右栏匹配薪酬申报的经费项目。', { exact: true }).waitFor();
  assert.equal(draft.projectNo, undefined);
  await page.getByRole('button', { name: '匹配 ' + project.projectName, exact: true }).click();
  await page.locator('.payroll-row .folder-project', { hasText: project.projectName }).waitFor();
  assert.equal(match.projectNo, project.projectNo);
  await page.getByRole('button', { name: '修改申报' }).click();
  assert.equal(draft.people[0].expenseItem, undefined);
  const edited = page.getByRole('dialog', { name: '修改薪酬申报' });
  assert.equal(await edited.getByLabel('经费项目').count(), 0);
  assert.equal(await edited.getByLabel('职称职务').inputValue(), '副高');
  await edited.getByText('本机已确认 · 尾号 5678').waitFor();
  assert.equal(await edited.getByLabel('按姓名和尾号选择人员').inputValue(), results[1].key);
  assert.equal(await edited.getByLabel('应发金额（元）').inputValue(), '123.45');
  assert.equal(await edited.getByLabel('用途', { exact: true }).inputValue(), '整理案例访谈记录并核对问卷编码');
  assert.equal(await edited.locator('#payrollSigner').innerText(), '示例教学加签人');
  await page.keyboard.press('Escape');
  await page.getByRole('checkbox', { name: '执行申报 整理案例访谈记录' }).check();
  await page.getByRole('button', { name: '填报选中项', exact: true }).click();
  await page.getByText(/批次已启动，共 1 笔/).waitFor();
  assert.deepEqual(execution, { entries: [{ payrollId: key, revision: 'revision' }] });
});

test('the second and third claim cards can be targeted independently of execution checkboxes', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const claims = ['1 教学讲义', '2 科研资料', '3 案例材料'].map((label, index) => ({
    path: `@事项/${index + 1}`, groupId: String(index + 1), label, sourceFolders: [label], subject: '办公用品', fileCount: 2, reimbursed: false,
  }));
  const saved = new Map();
  const assignments = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/folders') return route.fulfill({ json: { sourceRoot: uiSourceRoot, folders: [], claims } });
    if (url.pathname === '/api/plans') {
      const { folder, project } = route.request().postDataJSON();
      return route.fulfill({ json: { plan: { ...uiPlan(), folder, project: project || { projectNo: '', projectName: '' } }, match: saved.get(folder) || null } });
    }
    if (url.pathname === '/api/project-match') {
      const { folder, match } = route.request().postDataJSON();
      assignments.push([folder, match.projectNo]);
      saved.set(folder, match);
      return route.fulfill({ json: { match } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${origin}/runner`);
  const rows = page.locator('#folderRows .folder-row');
  await rows.last().locator('.row-state', { hasText: '待匹配' }).waitFor();
  const first = rows.nth(0);
  const second = rows.nth(1);
  const third = rows.nth(2);
  const target = page.locator('#matchTarget strong');
  assert.equal(await target.innerText(), claims[0].label);
  await second.locator('.claim-sources summary').click();
  assert.equal(await target.innerText(), claims[0].label);
  await second.click({ position: { x: 4, y: 5 } });
  assert.equal(await target.innerText(), claims[1].label);
  assert.equal(await second.locator('.claim-sources').getAttribute('open'), '');
  assert.equal(await second.locator('.row-select').isChecked(), false);
  await third.locator('.row-select').check();
  await third.locator('.folder-reason-input').click();
  assert.equal(await target.innerText(), claims[1].label);
  await page.getByRole('button', { name: '匹配 模拟教学经费', exact: true }).click();
  await second.locator('.folder-project', { hasText: '模拟教学经费' }).waitFor();
  assert.deepEqual(assignments, [[claims[1].path, uiProjects[0].projectNo]]);

  await third.locator('.folder-amount').click();
  assert.equal(await target.innerText(), claims[2].label);
  await first.getByRole('button', { name: `匹配经费 ${claims[0].label}` }).click();
  assert.equal(await target.innerText(), claims[0].label);
  const thirdMatch = third.getByRole('button', { name: `匹配经费 ${claims[2].label}` });
  await thirdMatch.press('Enter');
  assert.equal(await target.innerText(), claims[2].label);
  assert.equal(await thirdMatch.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.folder-row.is-current').count(), 1);
  assert.equal(await third.locator('.row-select').isChecked(), true);
  await page.getByRole('button', { name: '匹配 模拟案例经费', exact: true }).click();
  await third.locator('.folder-project', { hasText: '模拟案例经费' }).waitFor();
  assert.deepEqual(assignments, [[claims[1].path, uiProjects[0].projectNo], [claims[2].path, uiProjects[2].projectNo]]);
  assert.equal(await first.locator('.folder-project').count(), 0);
});

async function setup(t, phase = 'confirm') {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route('**/*', (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin);
  const frame = page.frames().find((item) => item.url().includes('/filling'));
  await frame.waitForFunction(() => window.fixtureState);
  await frame.evaluate((phase) => { window.fixtureState.phase = phase; window.fixtureRender(); }, phase);
  const plan = { reason, subject: 'AI服务', totalCny: 9000, invoiceTotalCny: 10000, paidTotalCny: 9000, project: { projectNo: 'TEST-2026-01' }, signer: { name: '示例教学加签人', employeeNo: '980001' }, paymentType: '教职工银行-建设银行', expenseType: '办公费', fingerprint: 'fixture', rows: [{ invoiceNumber: number, invoiceAmountCny: 10000, paidAmountCny: 9000, reimbursementAmountCny: 9000 }], uploadFiles: [], batches: [] };
  const instance = new ReimbursementExecutor({ plan, appDir: '/private/tmp', onEvent() {}, ask: async () => '确认提交', control: { progress: { documentId: 'DOC-000001', detailVerified: true, paymentVerified: true, uploads: [], submission: { state: 'not_started' } } } });
  instance.page = page;
  instance.submissionTimeoutMs = 50;
  return { page, frame, plan, instance };
}

test('Didi wallet loads all same-day cards, uses the project cap, and submits in its own school category', async (t) => {
  const { instance, page, frame, plan } = await setup(t, 'start');
  const tickets = [7000, 5900, 4000, 10000, 9999].map((amountCny, index) => ({
    invoiceNumber: String(1234567890123450 + index), amountCny, date: '2026-11-04',
  }));
  Object.assign(plan, {
    subject: '贸大出行', claimType: '贸大出行', expenseType: '市内差旅费',
    didi: { budgetCny: 11000 }, project: { projectNo: 'TEST-2026-01', projectName: '测试项目' },
    rows: [], totalCny: null, invoiceTotalCny: null, paidTotalCny: null,
  });
  instance.getSubmittedInvoices = () => [tickets[3].invoiceNumber];
  instance.control.autoSubmit = true;
  instance.control.portalPageId = await browserTargetId(page);
  instance.submissionTimeoutMs = 3500;
  delete instance.progress.documentId;
  instance.progress.paymentVerified = false;
  instance.progress.detailVerified = false;
  instance.ask = async (message) => assert.fail(message);
  instance.openPlatform = async () => {};
  await frame.evaluate(({ tickets, reason }) => {
    const app = document.getElementById('app');
    const money = (cents) => (cents / 100).toFixed(2);
    const replace = (html) => { app.innerHTML = html; };
    const body = document.body;
    const counters = window.didiCounters = { more: 0, added: 0, category: 0, submitted: 0 };
    let selected = [];
    let total = '';
    let amountPaid = '';
    const project = '<p>TEST-2026-01 测试项目</p>';
    const topic = '<h1>单据填报-贸大出行</h1>';
    const detail = () => '<section><h2>报销支出费用明细</h2><div class="el-collapse-item"><div class="detail"><input placeholder="请输入金额" value="' + total + '"><input placeholder="请输入用途"></div></div><p>待分配金额：￥0.00</p></section>';
    const card = (ticket, disabled = false) => '<div class="bill"><label class="el-checkbox"><input type="checkbox" value="' + ticket.invoiceNumber + '"' + (disabled ? ' disabled' : '') + '>选票</label><div class="item"><span class="label">发票号码</span><span>' + ticket.invoiceNumber + '</span></div><div class="item"><span class="label">合计金额</span><span>' + money(ticket.amountCny) + '</span></div><div class="item"><span class="label">销售方名称</span><span>滴滴平台</span></div><div class="item"><span class="label">开票日期</span><span>' + ticket.date + '</span></div></div>';
    const updatePayment = () => {
      document.getElementById('remaining').textContent = '待支付金额：￥' + (Number(total) - Number(amountPaid)).toFixed(2);
    };
    function showDetail(bank = false) {
      replace(topic + project + detail() + '<section><h2>支付信息</h2>' + (bank
        ? '<p>教职工银行-建设银行</p><input placeholder="请输入金额" data-bank value="' + amountPaid + '"><p id="remaining"></p>'
        : '<button data-didi="add-bank">添加支付类型</button>') + '<button data-didi="pay">保存并下一步</button></section>');
      app.querySelector('input[placeholder="请输入用途"]').value = reason;
      if (bank) updatePayment();
    }
    history.replaceState(null, '', '/ClaimsPublicPCWeb/fast-reimbursement');
    replace('<section><h2>经费预算信息</h2><table><thead><tr><th>项目编号</th><th>项目名称</th><th>项目余额/授权金额</th></tr></thead><tbody><tr><td>TEST-2026-01</td><td>测试项目</td><td>99.00</td></tr></tbody></table></section><div class="fast-reimbursement-divBottom"><div class="fast-reimbursement-cardHead">票据影像</div><button data-didi="images">添加</button><div class="theSecondStep-top"><div class="theSecondStep-divFlex"></div></div></div><button data-didi="next">下一步</button>');
    body.addEventListener('input', (event) => {
      if (event.target.matches('[data-bank]')) { amountPaid = event.target.value; updatePayment(); }
    });
    body.addEventListener('change', (event) => {
      if (!event.target.closest('.bill-list')) return;
      selected = [...app.querySelectorAll('.bill-list input:checked')].map((input) => tickets.find((ticket) => ticket.invoiceNumber === input.value));
      total = money(selected.reduce((sum, { amountCny }) => sum + amountCny, 0));
      app.querySelector('footer span').textContent = '已选影像数量：' + selected.length + '合计金额：' + total;
    });
    body.addEventListener('click', (event) => {
      switch (event.target.dataset.didi) {
        case 'images': {
          app.insertAdjacentHTML('beforeend', '<button data-didi="wallet">从票夹选择</button>');
          break;
        }
        case 'wallet': {
          event.target.remove();
          app.insertAdjacentHTML('beforeend', '<div role="dialog" aria-label="选择发票"><div class="floder-item"><div class="floder-name" data-didi="folder">滴滴平台</div><div>共5张票据|已选0张</div></div><div class="bill-list"></div><footer class="el-dialog__footer"><span>已选影像数量：0合计金额：0.00</span><button data-didi="confirm-wallet">确认</button></footer></div>');
          break;
        }
        case 'folder': {
          event.target.parentElement.classList.add('active');
          app.querySelector('.bill-list').innerHTML = '<div class="list">' + tickets.slice(0, 2).map((ticket) => card(ticket)).join('') + '</div><button data-didi="more">加载更多</button>';
          break;
        }
        case 'more': {
          counters.more++;
          event.target.outerHTML = '<div class="list">' + tickets.slice(2).map((ticket, index) => card(ticket, index === 2)).join('') + '</div>';
          break;
        }
        case 'confirm-wallet': {
          counters.added++;
          app.querySelector('[role="dialog"]').remove();
          const grid = app.querySelector('.theSecondStep-divFlex');
          grid.innerHTML = selected.map((ticket) => '<div class="bill-card"><span>出行订单</span><p>' + money(ticket.amountCny) + '</p><p>销方：滴滴平台</p><p>日期：' + ticket.date + '</p></div>').join('');
          grid.insertAdjacentHTML('beforebegin', '<p>当前票据总张数:' + selected.length + '张 当前票据总金额:￥' + total + '元 当前附件总张数:0张</p>');
          break;
        }
        case 'next':
          replace('<label class="el-radio"><input type="radio" name="category" value="travel"><span>日常报销</span></label><label class="el-radio"><input type="radio" name="category" value="didi"><span>贸大出行</span></label><button data-didi="fill">单据填报</button>');
          break;
        case 'fill':
          if (app.querySelector('input:checked')?.value !== 'didi') return;
          counters.category++;
          history.replaceState(null, '', '/ClaimsPublicPCWeb/reimburse?id=FIXTURE-DIDI-DRAFT');
          replace(topic + project + '<input role="textbox" aria-autocomplete="list" value=""><button data-didi="save">保存并下一步</button>');
          break;
        case 'save':
          if (app.querySelector('input').value !== reason) return;
          showDetail();
          break;
        case 'add-bank':
          app.insertAdjacentHTML('beforeend', '<button data-didi="bank">教职工银行-建设银行</button>');
          break;
        case 'bank':
          showDetail(true);
          break;
        case 'pay':
          if (amountPaid !== total) return;
          app.insertAdjacentHTML('beforeend', '<div class="el-dialog"><h2>请选择线上审批加签人</h2><p>980001—示例教学加签人</p><p>报销金额：' + total + '</p><button data-didi="signer">确认</button></div>');
          break;
        case 'signer':
          app.querySelector('.el-dialog').outerHTML = '<div class="el-dialog"><h2>确认提交报销单</h2><p>980001—示例教学加签人</p><p>报销金额：' + total + '</p><button data-didi="submit">提交预审</button></div>';
          break;
        case 'submit':
          counters.submitted++;
          history.replaceState(null, '', '/ClaimsPublicPCWeb/expenseAccountInquiry?code=FIXTURE-DIDI-001');
          replace('<h1>报销单查询</h1><div class="el-table"><table><thead><tr><th>报销单号</th><th>状态</th><th>经费项目</th><th>报销/借款事由</th><th>支付金额</th><th>报销/借款金额</th></tr></thead><tbody><tr><td>FIXTURE-DIDI-001</td><td>提交</td><td>测试项目</td><td></td><td>' + total + '</td><td>0.00</td></tr></tbody></table></div>');
          app.querySelectorAll('tbody td')[3].textContent = reason;
          break;
      }
    });
  }, { tickets, reason: plan.reason });
  instance.workContext = frame;
  instance.resumeStages = true;
  assert.equal(await instance.run(), 'submitted');
  assert.equal(plan.totalCny, 9900);
  assert.deepEqual(plan.rows.map(({ invoiceNumber }) => invoiceNumber), [tickets[1].invoiceNumber, tickets[2].invoiceNumber]);
  assert.equal(instance.progress.didiWallet.state, 'verified');
  assert.equal(instance.progress.submission.financeFormId, 'FIXTURE-DIDI-001');
  assert.deepEqual(await frame.evaluate(() => window.didiCounters), { more: 1, added: 1, category: 1, submitted: 1 });
  assert.equal(await browserTargetId(page), instance.progress.uploadPageId);
});

test('owned visible frame excludes the hidden historical query', async (t) => {
  const { instance } = await setup(t, 'detail');
  assert.ok(!(await instance.bodyText()).includes('其他历史单据'));
  assert.equal(await instance.detectStage(), 'detail_payment');
});

test('claim entry clicks the visible text beside the favorite star and waits for the new form', async (t) => {
  const { page, instance } = await setup(t, 'start');
  await page.goto(`${origin}/claim-entry`);
  const reached = await Promise.race([
    instance.openClaim().then(() => 'form'),
    page.waitForFunction(() => window.favoriteClicks > 0, undefined, { timeout: 6000 }).then(() => 'favorite'),
  ]);
  assert.equal(reached, 'form');
  assert.deepEqual(await page.evaluate(() => [window.entryClicks, window.favoriteClicks]), [1, 0]);
  assert.equal(await instance.detectStage(), 'start');
  assert.match(instance.workContext.url(), /fast-reimbursement/);
});

test('claim entry waits for campus authentication and continues in the original tab', async (t) => {
  const { page, instance } = await setup(t, 'start');
  const login = 'https://authserver.suibe.edu.cn/esc-sso/login/page';
  await page.route(login, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<a href="${origin}/claim-entry">完成认证</a>`,
  }));
  await page.route(`${origin}/entry-with-login`, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<script>setTimeout(() => location.href = ${JSON.stringify(login)}, 150)</script>`,
  }));
  instance.portalOrigin = origin;
  let signalWaiting;
  const waiting = new Promise((resolve) => { signalWaiting = resolve; });
  instance.onEvent = (event) => {
    if (event.step === '等待校园网登录') signalWaiting(true);
  };
  await page.goto(`${origin}/entry-with-login`);
  const originalTab = await browserTargetId(page);
  const reached = instance.openClaim().then(() => true, () => false);
  assert.equal(await Promise.race([waiting, page.waitForTimeout(2500).then(() => false)]), true);
  assert.equal(instance.control.waitingForCampusLogin, true);
  await page.getByRole('link', { name: '完成认证' }).click();
  assert.equal(await reached, true);
  assert.equal(Boolean(instance.control.waitingForCampusLogin), false);
  assert.equal(await browserTargetId(page), originalTab);
  assert.equal(await page.evaluate(() => window.entryClicks), 1);
  assert.equal(page.context().pages().length, 1);
});

test('a reminder appears at final approval and the verified submission clicks once', async (t) => {
  const { instance, frame } = await setup(t);
  instance.plan.warnings = ['缺少已核对签字的签收单'];
  instance.ask = async (question, metadata) => {
    assert.equal(metadata.kind, 'final_approval');
    assert.match(question, /核对提醒[\s\S]*缺少已核对签字的签收单/);
    return '确认提交';
  };
  assert.equal(await instance.confirmAndFinish(), 'submitted');
  assert.equal(await frame.evaluate(() => window.submitClicks), 1);
  assert.equal(instance.progress.submission.state, 'verified');
});

test('an unrelated query URL cannot verify a silent submission', async (t) => {
  const { instance, frame } = await setup(t);
  await frame.evaluate(() => document.getElementById('submit').removeAttribute('data-action'));
  assert.equal(await instance.confirmAndFinish(), 'verification_required');
  assert.notEqual(instance.progress.submission.state, 'verified');
  assert.equal(await instance.run(), 'verification_required');
});

test('a new failure notice saying 未提交成功 remains uncertain', async (t) => {
  const { instance, frame } = await setup(t);
  await frame.evaluate(() => {
    const submit = document.getElementById('submit');
    submit.removeAttribute('data-action');
    submit.addEventListener('click', () => document.body.insertAdjacentHTML('beforeend', '<div class="el-message">未提交成功，请稍后重试</div>'));
  });
  assert.equal(await instance.confirmAndFinish(), 'verification_required');
});

test('declining final approval leaves the document untouched', async (t) => {
  const { instance, frame } = await setup(t);
  instance.ask = async () => '先别提交';
  assert.equal(await instance.confirmAndFinish(), 'preview');
  assert.equal(await frame.evaluate(() => window.submitClicks || 0), 0);
});

test('a changed source after approval revokes submission', async (t) => {
  const { instance, frame } = await setup(t);
  let changed = false;
  instance.validate = async () => { if (changed) throw new Error('附件已变化'); };
  instance.ask = async () => { changed = true; return '确认提交'; };
  await assert.rejects(instance.confirmAndFinish(), /附件已变化/);
  assert.equal(await frame.evaluate(() => window.submitClicks || 0), 0);
});

test('discounted detail checks use current edited input rather than its invoice limit', async (t) => {
  const { instance, frame } = await setup(t, 'detail');
  await frame.locator('input[data-expense]').fill('90.00');
  await instance.verifyDetailAmounts();
  assert.equal(instance.progress.detailVerified, true);
});

test('hidden chooser names and an unrelated empty table do not prove uploaded images', async (t) => {
  const { instance, frame, plan } = await setup(t, 'start');
  plan.uploadFiles = [{ name: '发票.pdf' }];
  await frame.evaluate(() => {
    document.querySelector('.uploaded-images').textContent = '存在未核对的影像';
    document.body.insertAdjacentHTML('beforeend', '<section><h2>支付信息</h2>暂无数据</section><div class="el-dialog" hidden><span title="发票.pdf">发票.pdf</span></div>');
  });
  const observed = await instance.uploadSnapshot();
  assert.deepEqual(observed.names, []);
  assert.equal(observed.empty, false);
});

test('an unrelated table cannot change which project balance column is read', async (t) => {
  const { instance, frame } = await setup(t, 'start');
  await frame.evaluate(() => {
    window.fixtureState.project = true;
    window.fixtureRender();
    document.body.insertAdjacentHTML('afterbegin', '<table><tr><th>其他项目余额/授权金额</th><th>无关表头</th></tr></table>');
  });
  await instance.addProject();
  assert.equal(instance.plan.project.balanceCny, 100000);
});

test('project selection resumes inside an already open budget dialog', async (t) => {
  const { instance, frame } = await setup(t, 'start');
  await frame.locator('[data-action="project"]').click();
  await instance.addProject();
  assert.equal(await frame.evaluate(() => window.fixtureState.project), true);
  assert.equal(instance.plan.project.balanceCny, 100000);
});

test('one school form allocates three projects, verifies payment and submits once', async (t) => {
  const { instance, frame, page, plan } = await setup(t, 'start');
  const projects = uiProjects.map(({ projectNo, projectName }, index) => ({ projectNo, projectName, amountCny: [3025, 2000, null][index], balance: [40, 30, 50][index] }));
  plan.project = projects[0];
  plan.projectAllocationDraft = projects;
  await frame.evaluate((projects) => {
    const app = document.querySelector('#app');
    const selected = [];
    const heading = '<tr><th>项目编号</th><th>项目名称</th><th>项目余额/授权金额</th></tr>';
    const cells = (project) => `<td>${project.projectNo}</td><td>${project.projectName}</td><td>${project.balance}.00</td>`;
    app.innerHTML = `<section><h2>经费预算信息</h2><button id="pick">添加</button><table><thead>${heading}</thead><tbody></tbody></table></section>`;
    document.querySelector('#pick').onclick = () => {
      app.insertAdjacentHTML('beforeend', `<div class="el-dialog"><h2>请选择预算项目</h2><table><tbody>${projects.map((project, index) => `<tr>${cells(project)}<td><input type="checkbox" value="${index}"></td></tr>`).join('')}</tbody></table><button>确认</button></div>`);
      const dialog = app.lastElementChild;
      dialog.querySelector('button').onclick = () => {
        const index = Number(dialog.querySelector('input:checked').value);
        selected.push(projects[index]);
        app.querySelector('tbody').innerHTML = selected.map((project) => `<tr>${cells(project)}</tr>`).join('');
        dialog.remove();
      };
    };
  }, projects);
  await instance.addProject();
  await instance.addProject();
  assert.equal(await frame.locator('section tbody tr').count(), 3);
  await frame.locator('section tbody tr').last().locator('td').last().evaluate((cell) => { cell.textContent = '39.00'; });
  await assert.rejects(instance.addProject(), /39\.00 元，不足分配的 39\.75 元/);

  plan.rows[0].invoiceFile = '发票.pdf';
  plan.uploadFiles = [{ name: '发票.pdf' }];
  instance.progress.uploadPageId = await browserTargetId(page);
  instance.progress.ownedDocument = true;
  instance.progress.uploads = [{ state: 'verified', files: ['发票.pdf'], proof: { schoolReceipt: { invoiceCount: 1, attachmentCount: 0, invoiceTotalCny: 10000 } } }];
  instance.control.autoSubmit = true;
  instance.ask = async () => assert.fail('the allocation should be filled automatically');
  await frame.evaluate(({ projects, reason }) => {
    history.replaceState(null, '', '/ClaimsPublicPCWeb/filling?id=FUNDING-TEST');
    const app = document.querySelector('#app');
    const expense = (subject, value, limit, main = false) => `<div class="el-collapse-item is-active"><button class="el-collapse-item__header" aria-expanded="true"><span class="subject">${subject}</span></button><div class="detail"><input placeholder="请输入金额" ${main ? 'data-funding' : ''} value="${value}"><span class="right-message">${value}/${limit}</span><input placeholder="请输入用途"></div></div>`;
    const box = (project, index) => `<div class="project-box"><div class="project-head"><div class="project-name">${project.projectNo}-${project.projectName}</div></div><div class="money-use">报销金额<span data-project-total></span></div><button role="tab" aria-selected="true">额度一</button><button role="tab" aria-selected="false">额度二</button><div class="el-tab-pane">${expense('办公费', [40, 25, 35][index].toFixed(2), index === 0 ? '40.00' : '0.00', true)}</div><div class="el-tab-pane" hidden>${expense('设备', '0.00', '0.00')}</div></div>`;
    app.innerHTML = `<p>报销单号：DOC-000001</p><div class="part-box"><div class="fast-reimbursement-cardHead"><div>报销支出费用明细</div></div>${projects.map(box).join('')}<p class="allocate-money"></p><p class="total-money">可分配报销金额：￥100.00</p></div><div class="part-box"><button>添加支付类型</button><p>教职工银行-建设银行</p><input id="payment" placeholder="请输入金额"><p id="pay-left"></p><button id="save-payment">保存并下一步</button></div>`;
    const update = () => {
      let total = 0;
      for (const project of app.querySelectorAll('.project-box')) {
        const amount = [...project.querySelectorAll('input[placeholder="请输入金额"]')].reduce((sum, field) => sum + Math.round(Number(field.value) * 100), 0);
        project.querySelector('[data-project-total]').textContent = (amount / 100).toFixed(2);
        total += amount;
      }
      app.querySelector('.allocate-money').textContent = `待分配金额：￥${((10000 - total) / 100).toFixed(2)}`;
      app.querySelector('#pay-left').textContent = `待支付金额:￥${(total / 100 - Number(app.querySelector('#payment').value)).toFixed(2)}`;
    };
    app.addEventListener('input', update);
    for (const project of app.querySelectorAll('.project-box')) {
      const tabs = [...project.querySelectorAll('[role=tab]')];
      const panes = [...project.querySelectorAll('.el-tab-pane')];
      for (const [index, tab] of tabs.entries()) tab.onclick = () => tabs.forEach((candidate, next) => {
        candidate.setAttribute('aria-selected', String(index === next));
        panes[next].hidden = index !== next;
      });
    }
    app.querySelector('#save-payment').onclick = () => {
      app.insertAdjacentHTML('beforeend', '<div class="el-dialog"><h2>请选择线上审批加签人</h2><p>980001—示例教学加签人</p><button>确认</button></div>');
      app.lastElementChild.querySelector('button').onclick = () => {
        window.fundingSubmitCount = (window.fundingSubmitCount || 0) + 1;
        history.replaceState(null, '', '/ClaimsPublicPCWeb/expenseAccountInquiry?code=FIXTURE-MULTI');
        app.innerHTML = `<h1>报销单查询</h1><div class="el-table"><table><thead><tr><th>报销单号</th><th>状态</th><th>经费项目</th><th>报销/借款事由</th><th>支付金额</th><th>报销/借款金额</th></tr></thead></table><table><tbody><tr><td>FIXTURE-MULTI</td><td>审批中</td><td>${projects[2].projectName}、${projects[0].projectNo}-${projects[0].projectName}、${projects[1].projectNo}</td><td>${reason}</td><td>90.00</td><td>90.00</td></tr></tbody></table></div>`;
      };
    };
    update();
  }, { projects, reason });
  await instance.fillProjectDetails();
  assert.deepEqual(await frame.locator('[data-funding]').evaluateAll((fields) => fields.map((field) => field.value)), ['30.25', '20.00', '39.75']);
  assert.equal(await frame.locator('.allocate-money').innerText(), '待分配金额：￥10.00');
  const fields = frame.locator('[data-funding]');
  await fields.first().fill('29.25');
  await fields.last().fill('40.75');
  await instance.fillProjectDetails();
  await fields.evaluateAll((items) => items.forEach((field) => {
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }));
  delete instance.progress.projectExpenseAmounts;
  plan.expenseType = '';
  instance.ask = async (_, { kind, choices }) => {
    assert.equal(kind, 'project_expense_type');
    return choices.find(({ label }) => label === '办公费').value;
  };
  await instance.fillProjectDetails();
  assert.deepEqual(await fields.evaluateAll((items) => items.map((field) => field.value)), ['30.25', '20.00', '39.75']);
  await frame.evaluate(() => {
    const payment = document.querySelector('#payment');
    const remaining = document.querySelector('#pay-left');
    payment.remove();
    setTimeout(() => remaining.before(payment), 300);
    payment.addEventListener('input', () => {
      setTimeout(() => { remaining.textContent = '待支付金额:￥0.00'; }, 800);
    });
    remaining.parentElement.addEventListener('input', (event) => {
      if (event.target === payment) event.stopPropagation();
    });
  });
  await instance.fillPayment();
  assert.equal(await frame.locator('#payment').inputValue(), '90.00');
  assert.equal(await frame.locator('#pay-left').innerText(), '待支付金额:￥0.00');
  const signer = frame.locator('.el-dialog');
  await fields.first().fill('29.25');
  await fields.last().fill('40.75');
  await assert.rejects(instance.confirmAndFinish(signer), /项目 TEST-2026-01 的金额或用途/);
  assert.equal(instance.progress.submission.state, 'not_started');
  await fields.first().fill('30.25');
  await fields.last().fill('39.75');
  const moveFirstAmount = (misplaced) => frame.locator('.project-box').first().evaluate((box, { misplaced, reason }) => {
    const fields = [...box.querySelectorAll('input[placeholder="请输入金额"]')];
    const [from, to] = misplaced ? fields : fields.reverse();
    to.value = from.value;
    from.value = '0.00';
    to.closest('.detail').querySelector('input[placeholder="请输入用途"]').value = reason;
    to.dispatchEvent(new Event('input', { bubbles: true }));
  }, { misplaced, reason });
  await moveFirstAmount(true);
  await assert.rejects(instance.confirmAndFinish(signer), /项目 TEST-2026-01.*办公费.*设备/);
  assert.equal(instance.progress.submission.state, 'not_started');
  assert.equal(await frame.evaluate(() => window.fundingSubmitCount || 0), 0);
  await moveFirstAmount(false);
  assert.equal(await instance.confirmAndFinish(signer), 'submitted');
  assert.equal(instance.progress.submission.financeFormId, 'FIXTURE-MULTI');
  assert.equal(await frame.evaluate(() => window.fundingSubmitCount), 1);
});

test('a different stable document ID invalidates confirmation even with the same invoices', async (t) => {
  const { instance, frame } = await setup(t);
  await frame.evaluate(() => { document.querySelector('#app > p').textContent = '报销单号：DOC-999999'; });
  await assert.rejects(instance.confirmAndFinish(), /身份|单据|草稿/);
  assert.equal(await frame.evaluate(() => window.submitClicks || 0), 0);
});

test('a form that truncates the approved reimbursement reason is not saved', async (t) => {
  const { instance, frame } = await setup(t, 'form');
  await frame.locator('[data-reason]').evaluate((input) => {
    input.addEventListener('input', () => { input.value = input.value.slice(0, 6); });
  });
  await assert.rejects(instance.fillForm(), /报销事由与确认内容不一致/);
  assert.equal(await frame.evaluate(() => window.fixtureState.phase), 'form');
});

test('the executor waits for a delayed expense type dialog and then its amount inputs', { timeout: 25000 }, async (t) => {
  const { instance, frame } = await setup(t, 'form');
  await frame.evaluate(() => {
    window.fixtureState.expenseDialogDelay = 10500;
    window.fixtureState.detailDelay = 700;
  });
  await instance.fillForm();
  assert.equal(await frame.evaluate(() => window.fixtureState.phase), 'detail');
  assert.equal(instance.progress.detailVerified, true);
});

test('replying continue confirms the categories already selected in the school dialog', async (t) => {
  const { instance, frame } = await setup(t, 'form');
  instance.plan.expenseType = null;
  await frame.evaluate(() => { window.fixtureState.expenseDialogDelay = 1; });
  let prompts = 0;
  instance.ask = async () => {
    prompts += 1;
    await frame.getByRole('radio', { name: '办公费', exact: true }).check();
    return '继续';
  };
  await instance.fillForm();
  assert.equal(prompts, 1);
  assert.equal(await frame.evaluate(() => window.fixtureState.phase), 'detail');
  assert.equal(instance.progress.detailVerified, true);
});

test('a grouped school detail uses the verified original upload and binds its draft ID', async (t) => {
  const { instance, frame, page, plan } = await setup(t, 'detail');
  const files = ['发票.pdf', '付款凭证.png'];
  plan.uploadFiles = files.map((name) => ({ name }));
  plan.rows[0].invoiceFile = files[0];
  plan.rows[0].reimbursementAmountCny = plan.rows[0].paidAmountCny = 10000;
  plan.totalCny = plan.paidTotalCny = 10000;
  instance.progress = instance.control.progress = {
    ownedDocument: true,
    uploadPageId: await browserTargetId(page),
    uploads: [{ state: 'verified', files, proof: { schoolReceipt: { invoiceCount: 1, attachmentCount: 1, invoiceTotalCny: 10000 } } }],
    submission: { state: 'not_started' },
  };
  await frame.evaluate(({ reason, projectNo }) => {
    history.replaceState(null, '', '/ClaimsPublicPCWeb/filling?id=school-draft-001');
    document.querySelector('#app > p').textContent = projectNo;
    document.querySelector('section table').outerHTML = '<div class="el-collapse-item"><div class="detail"><input placeholder="请输入金额" value="100.00"><input placeholder="请输入用途"></div></div>';
    document.querySelector('[placeholder="请输入用途"]').value = reason;
  }, { reason: plan.reason, projectNo: plan.project.projectNo });
  instance.ask = async () => { throw new Error('unexpected amount review'); };
  await instance.verifyDetailAmounts();
  assert.equal(instance.progress.detailVerified, true);
  assert.equal(instance.progress.fillingId, 'school-draft-001');
  await frame.evaluate(() => history.replaceState(null, '', '/ClaimsPublicPCWeb/filling?id=school-draft-002'));
  await assert.rejects(instance.assertDocumentIdentity(), /草稿已变化/);
});

test('a school-truncated grouped purpose is shown for approval and rechecked before submission', async (t) => {
  const { instance, frame, page, plan } = await setup(t, 'detail');
  plan.reason = '模拟实验课程演示软件许可费';
  const actualPurpose = '模拟实验课程演示软件';
  const files = ['模拟票据甲.pdf', '模拟票据乙.pdf', '模拟支付.png'];
  plan.uploadFiles = files.map((name) => ({ name }));
  const { invoiceNumber } = plan.rows[0];
  plan.rows = [6100, 3700].map((amountCny, index) => ({
    invoiceNumber: invoiceNumber.slice(0, -1) + (index + 1), invoiceFile: files[index],
    invoiceAmountCny: amountCny, paidAmountCny: amountCny, reimbursementAmountCny: amountCny,
  }));
  plan.totalCny = plan.invoiceTotalCny = plan.paidTotalCny = 9800;
  instance.control.autoSubmit = true;
  instance.progress = instance.control.progress = {
    ownedDocument: true, uploadPageId: await browserTargetId(page), uploads: [{
      state: 'verified', files, proof: { schoolReceipt: { invoiceCount: 2, attachmentCount: 1, invoiceTotalCny: 9800 } },
    }], submission: { state: 'not_started' }, paymentVerified: true,
  };
  await frame.evaluate(({ projectNo, signer, actualPurpose }) => {
    history.replaceState(null, '', '/ClaimsPublicPCWeb/filling?id=fixture-purpose-limit');
    document.querySelector('#app').innerHTML = `<p>${projectNo} ${signer.name} ${signer.employeeNo}</p>
      <section><h2>报销支出费用明细</h2><div class="el-collapse-item"><div class="detail">
        <input placeholder="请输入金额" value="98.00"><input placeholder="请输入用途" maxlength="${actualPurpose.length}">
      </div></div><p>待分配金额：￥0.00</p></section>
      <div class="el-dialog"><h2>确认提交报销单</h2><p>报销金额：98.00</p><button>提交预审</button></div>`;
    document.querySelector('button').onclick = () => { window.confirmClicks = (window.confirmClicks || 0) + 1; };
    document.querySelector('[placeholder="请输入用途"]').value = actualPurpose;
  }, { projectNo: plan.project.projectNo, signer: plan.signer, actualPurpose });
  const purpose = frame.getByPlaceholder('请输入用途');
  await purpose.evaluate((field) => field.removeAttribute('maxlength'));
  await assert.rejects(instance.verifyDetailAmounts(), /用途核验失败/);
  await purpose.evaluate((field, limit) => { field.maxLength = limit; }, actualPurpose.length);
  await instance.verifyDetailAmounts();
  assert.equal(instance.progress.schoolDetailPurpose, actualPurpose);
  assert.equal(instance.progress.detailVerified, true);
  instance.ask = async (question, metadata) => {
    assert.equal(metadata.kind, 'final_approval');
    assert.ok(question.includes(plan.reason));
    assert.ok(question.includes(`实际显示「${actualPurpose}」`));
    return '先别提交';
  };
  assert.equal(await instance.confirmAndFinish(), 'preview');
  instance.ask = async () => {
    await purpose.fill('修改后的其他用途');
    return '确认提交';
  };
  await assert.rejects(instance.confirmAndFinish(), /用途核验失败/);
  assert.equal(await frame.evaluate(() => window.confirmClicks || 0), 0);
});

test('the school receipt verifies this upload without displaying the original filenames', async (t) => {
  const { instance, frame, plan } = await setup(t, 'start');
  const directory = await mkdtemp(join(tmpdir(), 'runner-upload-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = ['发票.pdf', '网站订单.pdf', '支付.png'];
  plan.uploadFiles = [];
  for (const name of files) { const absolutePath = join(directory, name); await writeFile(absolutePath, 'synthetic local upload'); plan.uploadFiles.push({ name, absolutePath }); }
  plan.rows[0].invoiceFile = '发票.pdf';
  plan.batches = [plan.uploadFiles];
  instance.progress = instance.control.progress = { uploads: [], submission: { state: 'not_started' } };
  instance.openPlatform = async () => {};
  instance.ask = async () => '先别提交';
  instance.uploadTimeoutMs = 200;
  await frame.evaluate(() => { window.fixtureState.hideUploadNames = true; });
  assert.equal(await instance.run(), 'preview');
  assert.equal(await frame.evaluate(() => window.submitClicks || 0), 0);
  assert.equal(await frame.evaluate(() => window.businessClicks || 0), 0);
  assert.equal(instance.progress.uploads[0].state, 'verified');
  assert.equal(instance.progress.paymentVerified, true);
});

test('a typed signer uses an exact school name and pauses for duplicate names', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const name = '模拟加签人';
  for (const ambiguous of [false, true]) {
    const candidates = [[name + '同', '1900'], [name, '1901'], ...(ambiguous ? [[name, '1902']] : [])];
    await page.setContent(`
      <div class="el-dialog"><h2>请选择线上审批加签人</h2><p id="selected">1900—${name}同</p>
        <button onclick="document.querySelector('#picker').hidden = false">加签人</button></div>
      <div id="picker" class="el-dialog" hidden><input placeholder="请输入姓名">
        <button onclick="window.queriedName = this.previousElementSibling.value">查询</button>
        <table><tbody>${candidates.map(([label, code]) => `<tr><td><input type="checkbox"></td><td>${label}</td><td>${code}</td></tr>`).join('')}</tbody></table>
        <button onclick="const row = document.querySelector('input:checked').closest('tr');
          document.querySelector('#selected').textContent = row.cells[2].textContent + '—' + row.cells[1].textContent;
          this.closest('#picker').hidden = true;">确认</button></div>
    `);
    let prompted = false;
    const instance = new ReimbursementExecutor({
      plan: { signer: { name, employeeNo: '' } },
      onEvent: () => {},
      async ask(message, metadata) {
        prompted = true;
        assert.equal(metadata.kind, 'signer_pick');
        assert.match(message, /多位/);
        assert.equal(await page.locator('#picker input:checked').count(), 0);
        await page.getByRole('row', { name: new RegExp('1902') }).getByRole('checkbox').check();
        return '继续';
      },
    });
    instance.page = page;
    instance.work = async () => page;
    await instance.addSigner();
    assert.equal(await page.evaluate(() => window.queriedName), name);
    assert.equal(await page.locator('#selected').innerText(), (ambiguous ? '1902—' : '1901—') + name);
    assert.equal(prompted, ambiguous);
  }
});

test('automatic submission records the signer click first and settles on the matching school receipt', async (t) => {
  const { instance, page, frame } = await setup(t, 'signer');
  instance.progress.uploadPageId = await browserTargetId(page);
  instance.control.autoSubmit = true;
  instance.submissionTimeoutMs = 2000;
  instance.ask = async () => { throw new Error('unexpected manual approval'); };
  await frame.evaluate(() => {
    history.replaceState(null, '', '/ClaimsPublicPCWeb/filling?id=fixture-draft-001');
    window.fixtureState.submitFromSigner = true;
    window.fixtureState.selected = true;
    window.fixtureRender();
  });
  const dialog = await instance.addSigner();
  instance.control.skipSubmit = true;
  assert.equal(await instance.confirmAndFinish(dialog), 'preview');
  assert.equal(await frame.evaluate(() => window.signerSubmitClicks || 0), 0);
  instance.control.skipSubmit = false;
  instance.onProgress = async (progress) => {
    if (progress.submission.state === 'attempted') assert.equal(await frame.evaluate(() => window.signerSubmitClicks || 0), 0);
  };
  assert.equal(await instance.confirmAndFinish(dialog), 'submitted');
  assert.equal(await frame.evaluate(() => window.signerSubmitClicks), 1);
  assert.equal(instance.progress.submission.financeFormId, 'FIXTURE-0001');
  instance.progress.submission = { state: 'attempted', fingerprint: instance.plan.fingerprint };
  instance.resumeStages = true;
  instance.openPlatform = async () => {};
  assert.equal(await instance.run(), 'submitted');
  assert.equal(await frame.evaluate(() => window.signerSubmitClicks), 1);
  await frame.evaluate(() => history.replaceState(null, '', '/ClaimsPublicPCWeb/expenseAccountInquiry?code=FIXTURE-0002'));
  assert.equal(await instance.schoolSubmissionReceipt(), null);
  await frame.evaluate(({ projectNo, reason }) => {
    document.querySelector('#app').innerHTML = '<h1>报销单查询</h1><div class="el-table"><table><thead><tr><th>报销单号</th><th>状态</th><th>经费项目</th><th>报销/借款事由</th><th>支付金额</th><th>报销/借款金额</th></tr></thead></table><table><tbody><tr><td>FIXTURE-0002</td><td>审批中</td><td></td><td></td><td>90.00</td><td>90.00</td></tr></tbody></table></div>';
    const cells = document.querySelector('tbody tr').cells;
    cells[2].textContent = projectNo;
    cells[3].textContent = reason;
  }, { projectNo: instance.plan.project.projectNo, reason: instance.plan.reason });
  assert.deepEqual(await instance.schoolSubmissionReceipt(), { financeFormId: 'FIXTURE-0002', receipt: '审批中' });
  await frame.locator('tbody td').nth(4).evaluate((cell) => { cell.textContent = '89.99'; });
  assert.equal(await instance.schoolSubmissionReceipt(), null);
});

test('a split payment uses the school fill action and waits until the school advances', async (t) => {
  const { instance, frame, plan } = await setup(t, 'detail');
  Object.assign(plan, {
    totalCny: 10000, paidTotalCny: 10000,
    projectAllocationDraft: projectFixture.map((project, index) => ({ ...project, amountCny: index === 0 ? 6000 : null })),
  });
  instance.paymentAdvanceTimeoutMs = 1600;
  await frame.evaluate((type) => {
    const app = document.querySelector('#app');
    app.innerHTML = `<section class="part-box"><h2>支付信息</h2><button>添加支付类型</button><p>${type}</p>
      <input placeholder="请输入金额"><button id="fill-all">全部填入</button><p id="remaining">待支付金额：￥100.00</p>
      <button id="save-payment">保存并下一步</button></section>`;
    const amount = app.querySelector('input');
    const left = app.querySelector('#remaining');
    window.schoolFillCount = 0;
    window.paymentSaveCount = 0;
    window.schoolCanSavePayment = false;
    let schoolAmount = '0.00';
    const renderAmount = () => { left.textContent = `待支付金额：￥${(100 - Number(amount.value)).toFixed(2)}`; };
    amount.oninput = renderAmount;
    app.querySelector('#fill-all').onclick = () => {
      window.schoolFillCount += 1;
      schoolAmount = '100.00';
      amount.value = schoolAmount;
      renderAmount();
    };
    app.querySelector('#save-payment').onclick = () => {
      window.paymentSaveCount += 1;
      if (!window.schoolCanSavePayment || schoolAmount !== '100.00') {
        amount.value = '';
        renderAmount();
        return;
      }
      app.insertAdjacentHTML('beforeend', '<div class="el-dialog"><h2>确认提交报销单</h2><button>提交预审</button></div>');
    };
  }, plan.paymentType);
  await assert.rejects(instance.fillPayment(), /学校仍显示待支付 100\.00 元/);
  assert.equal(instance.progress.paymentVerified, false);
  await frame.evaluate(() => { window.schoolCanSavePayment = true; });
  assert.equal(await instance.fillPayment(), 'confirm');
  assert.equal(instance.progress.paymentVerified, true);
  assert.deepEqual(await frame.evaluate(() => [window.schoolFillCount, window.paymentSaveCount]), [2, 2]);
});

test('the late confirmation on the school pre-review page is accepted once and verified by its receipt', async (t) => {
  const { instance, page, frame, plan } = await setup(t, 'signer');
  instance.progress.uploadPageId = await browserTargetId(page);
  instance.progress.fillingId = 'fixture-draft-002';
  instance.control.autoSubmit = true;
  instance.submissionTimeoutMs = 2000;
  await frame.evaluate(({ reason, projectNo }) => {
    history.replaceState(null, '', '/ClaimsPublicPCWeb/filling?id=fixture-draft-002');
    window.fixtureState.selected = true;
    window.fixtureRender();
    document.querySelector('[data-action="confirm-signer"]').onclick = (event) => {
      event.stopPropagation();
      window.signerClicks = (window.signerClicks || 0) + 1;
      setTimeout(() => {
        history.replaceState(null, '', '/ClaimsPublicPCWeb/preliminaryExamination?code=FIXTURE-0010');
        const app = document.getElementById('app');
        app.innerHTML = `<p>报销单号：DOC-000001</p><p>${projectNo} 示例教学加签人 980001</p><p>报销金额：90.00</p>
          <input placeholder="请输入用途"><div class="el-dialog"><h2>确认提交报销单</h2><button>提交预审</button></div>`;
        app.querySelector('input').value = reason;
        app.querySelector('button').onclick = () => {
          window.finalSubmitClicks = (window.finalSubmitClicks || 0) + 1;
          app.querySelector('.el-dialog').remove();
          setTimeout(() => {
            app.insertAdjacentHTML('beforeend', '<div class="el-message-box"><p>是否提交这张报销单？</p><button>确定</button></div>');
            app.querySelector('.el-message-box button').onclick = () => {
              window.followupClicks = (window.followupClicks || 0) + 1;
              history.replaceState(null, '', '/ClaimsPublicPCWeb/expenseAccountInquiry?code=FIXTURE-0010');
              app.innerHTML = '<p>您的报销单：FIXTURE-0010</p><p>已处理完成</p>';
            };
          }, 450);
        };
      }, 100);
    };
  }, { reason: plan.reason, projectNo: plan.project.projectNo });
  instance.onProgress = async (progress) => {
    if (progress.submission.state === 'attempted' && progress.submission.action === 'request_pre_review') {
      assert.equal(await frame.evaluate(() => window.finalSubmitClicks || 0), 0);
    }
    if (progress.submission.state === 'attempted' && progress.submission.action === 'confirm_pre_review') {
      assert.equal(await frame.evaluate(() => window.followupClicks || 0), 0);
    }
  };
  assert.equal(await instance.confirmAndFinish(await instance.addSigner()), 'submitted');
  assert.equal(instance.progress.submission.financeFormId, 'FIXTURE-0010');
  assert.equal(instance.progress.preReviewFinanceFormId, 'FIXTURE-0010');
  assert.equal(instance.progress.submission.action, 'confirm_pre_review');
  assert.deepEqual(await frame.evaluate(() => [window.signerClicks, window.finalSubmitClicks, window.followupClicks]), [1, 1, 1]);
});

test('pre-review recovery confirms only a recorded pending dialog on the original draft', async (t) => {
  const { instance, page, frame, plan } = await setup(t, 'confirm');
  instance.progress.uploadPageId = await browserTargetId(page);
  instance.progress.fillingId = 'fixture-original';
  instance.resumeStages = true;
  instance.openPlatform = async () => {};
  await frame.evaluate(() => {
    const app = document.getElementById('app');
    app.innerHTML = '<div class="el-message-box"><p>是否提交这张报销单？</p><button>确定</button></div>';
    app.querySelector('button').onclick = () => {
      window.followupClicks = (window.followupClicks || 0) + 1;
      history.replaceState(null, '', '/ClaimsPublicPCWeb/expenseAccountInquiry?code=FIXTURE-0011');
      app.innerHTML = '<p>您的报销单：FIXTURE-0011</p><p>审批中</p>';
    };
  });
  for (const [action, draft] of [
    ['submit_pre_review', 'fixture-original'],
    ['confirm_pre_review', 'fixture-original'],
    ['request_pre_review', 'fixture-other'],
    ['request_pre_review', 'fixture-original'],
  ]) {
    await frame.evaluate((draft) => history.replaceState(null, '', '/ClaimsPublicPCWeb/filling?id=' + draft), draft);
    instance.progress.submission = { state: 'verification_required', action, fingerprint: plan.fingerprint };
    const canConfirm = action === 'request_pre_review' && draft === 'fixture-original';
    instance.submissionTimeoutMs = canConfirm ? 2000 : 50;
    assert.equal(await instance.run(), canConfirm ? 'submitted' : 'verification_required');
    assert.equal(await frame.evaluate(() => window.followupClicks || 0), canConfirm ? 1 : 0);
  }
  assert.equal(instance.progress.submission.financeFormId, 'FIXTURE-0011');
});

test('grouped uploads give same-named source files distinct school filenames', async (t) => {
  const { instance, frame, plan } = await setup(t, 'start');
  const root = await mkdtemp(join(tmpdir(), 'grouped-upload-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  plan.uploadFiles = [];
  for (const [index, name] of [[1, '发票.pdf'], [1, '付款.png'], [2, '付款.png']]) {
    const originalPath = join(root, String(index), name);
    await mkdir(join(root, String(index)), { recursive: true });
    await writeFile(originalPath, 'synthetic source ' + index);
    plan.uploadFiles.push({ name: index + '__' + name, absolutePath: originalPath });
  }
  plan.rows[0].invoiceFile = plan.uploadFiles[0].name;
  plan.batches = [plan.uploadFiles];
  instance.progress = instance.control.progress = { uploads: [], submission: { state: 'not_started' } };
  instance.openPlatform = async () => {};
  instance.ask = async () => '先别提交';
  await frame.evaluate(() => { window.fixtureState.hideUploadNames = true; });
  assert.equal(await instance.run(), 'preview');
  assert.deepEqual(await frame.evaluate(() => window.fixtureState.files), ['1__发票.pdf', '1__付款.png', '2__付款.png']);
  assert.equal(await readFile(join(root, '1/付款.png'), 'utf8'), 'synthetic source 1');
  assert.equal(await readFile(join(root, '2/付款.png'), 'utf8'), 'synthetic source 2');
});

test('project sync skips the hidden budget controls and reads both pages in one form', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route('**/*', (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage();
  assert.deepEqual(await readWebProjectCatalog(page, `${origin}/school-portal`), projectFixture);
  assert.equal(await page.evaluate(() => window.entryClicks), 1);
  assert.deepEqual(await page.frame({ url: `${origin}/project-budget` }).evaluate(() => window.selectedProjects), projectFixture);
  assert.equal(context.pages().length, 1);
});

test('project sync reports a school login redirect without exposing Playwright errors', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const login = 'https://authserver.suibe.edu.cn/esc-sso/login/page';
  await page.route(login, (route) => route.fulfill({ body: '学校统一身份认证' }));
  await page.route(`${origin}/school-portal`, (route) => route.fulfill({ status: 302, headers: { location: login } }));
  await assert.rejects(readWebProjectCatalog(page, `${origin}/school-portal`), /检查校园网登录/);
});

test('the newest failed batch is shown with its start time and a readable error', async (t) => {
  const context = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  t.after(() => context.close());
  await context.route('**/*', (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage();
  const run = (id, time, error) => ({ id, status: 'error', plan: uiPlan(), createdAt: time, updatedAt: time, error, events: [], messages: [] });
  const newer = run('newer', '2026-11-10T04:33:20Z', '经费区域暂未加载\nCall log:\n\x1b[2m技术明细');
  const older = run('older', '2026-11-10T04:01:25Z', '上一轮入口错误');
  const batch = (item) => ({ id: `batch-${item.id}`, status: 'error', currentIndex: 0, currentRunId: item.id, createdAt: item.createdAt, runs: [item] });
  await page.route('**/api/runs', (route) => route.fulfill({ json: { runs: [newer, older] } }));
  await page.route('**/api/batches', (route) => route.fulfill({ json: { batches: [batch(newer), batch(older)] } }));
  await page.goto(`${origin}/runner`);
  await page.locator('#runToggle').click();
  const status = page.locator('#runStatus', { hasText: '经费区域暂未加载' });
  await status.waitFor({ timeout: 3000 });
  const display = await status.innerText();
  assert.match(display, /13:33:20/);
  assert.ok(!display.includes('Call log'));
  assert.ok(!display.includes('上一轮入口错误'));
});

test('the worklist groups source folders before saving purpose, matching funding and batch execution', async (t) => {
  uiChecks = 0;
  uiExecuteRequests = 0;
  uiPurposePayload = undefined;
  uiPreparedPlan = undefined;
  uiMatch = undefined;
  uiReasonDraft = '';
  uiReasonSaved = false;
  uiGroup = null;
  uiSigner = undefined;
  uiSignerNames = [];
  uiSignerRoster = [uiTeachingSigner];
  uiProjectSigners = {};
  t.after(() => { uiProjectSigners = {}; uiSignerRoster = [uiTeachingSigner]; });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  await context.route('**/*', (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.addInitScript((folder) => {
    localStorage.setItem('reimbursement-assistant-row-configs', JSON.stringify({ [folder]: { projectChoice: 'DEMO-BUDGET-101' } }));
  }, uiFolder);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/runner`);
  await page.getByLabel(`选择来源 ${uiFolder}`, { exact: true }).check();
  await page.getByLabel(`选择来源 ${uiSecondFolder}`, { exact: true }).check();
  assert.equal(await page.locator('#sourceRows textarea').count(), 0);
  assert.equal(await page.locator('#folderRows textarea').count(), 0);
  await page.getByRole('button', { name: '合并为报销事项', exact: true }).click();
  const routeDialog = page.getByRole('dialog', { name: '办理方式' });
  assert.equal(await routeDialog.getByLabel('办理系统', { exact: true }).inputValue(), 'smart');
  await routeDialog.getByRole('button', { name: '合并', exact: true }).click();
  await page.locator('.row-state', { hasText: '待匹配' }).waitFor();
  assert.ok(uiChecks >= 1);
  assert.equal(uiProject, null);
  assert.equal(await page.locator('.row-select').isDisabled(), false);
  assert.equal(await page.locator('#sourceRows input:disabled').count(), 2);
  assert.match(await page.locator('.claim-sources').innerText(), /2 个来源文件夹 · 已保存/);
  const editRoute = page.getByRole('button', { name: `更改办理方式 ${uiFolder}` });
  await page.getByLabel('筛选办理系统').selectOption('smart');
  await editRoute.click();
  await routeDialog.getByLabel('办理系统', { exact: true }).selectOption('legacy');
  await routeDialog.getByRole('button', { name: '保存', exact: true }).click();
  await editRoute.filter({ hasText: '日常线下报销' }).waitFor();
  assert.equal(await page.getByLabel('筛选办理系统').inputValue(), 'legacy');
  await editRoute.click();
  assert.equal(await routeDialog.getByLabel('办理系统', { exact: true }).inputValue(), 'legacy');
  await routeDialog.getByLabel('办理系统', { exact: true }).selectOption('smart');
  await routeDialog.getByRole('button', { name: '保存', exact: true }).click();
  await editRoute.filter({ hasText: '智能报销系统' }).waitFor();
  assert.equal(await page.getByLabel('筛选办理系统').inputValue(), 'smart');
  await page.getByLabel('筛选办理系统').selectOption('');
  await page.locator('.row-select').check();
  await page.locator('#executeSelected').click();
  assert.match(await page.locator('#executionStatus').innerText(), /匹配经费项目/);
  assert.equal(uiExecuteRequests, 0);
  assert.match(await page.locator('.folder-figure').innerText(), /98\.76[\s\S]*核定报销/);
  assert.match(await page.locator('#historyHeading').innerText(), /已报销（1）/);
  await page.locator('#historyHeading').click();
  assert.equal(await page.locator('#historyRows').innerText(), uiArchived);
  assert.equal(await page.locator('#reimbursedHistory button, #reimbursedHistory input').count(), 0);
  const handwritten = '金融文本分析实训：打印供学生标注财报段落的练习讲义';
  const reasonInput = page.getByLabel(`报销事由 ${uiFolder}`);
  await reasonInput.fill(handwritten);
  await page.locator('.reason-status', { hasText: '草稿已保存' }).waitFor();
  assert.equal(uiReasonDraft, handwritten);
  assert.equal(uiPurposePayload, undefined);
  await page.getByRole('button', { name: '同步项目和余额' }).click();
  const teaching = page.locator('.project-match', { hasText: '模拟教学经费' });
  await teaching.getByText('¥1,000.00', { exact: true }).waitFor();
  assert.match(await teaching.innerText(), /项目总额 ¥5,000\.00/);
  const research = page.locator('.project-match', { hasText: '模拟科研经费' });
  assert.equal(await research.locator('.project-balance').innerText(), '可用金额 ¥0.00');
  assert.doesNotMatch(await research.innerText(), /项目总额/);
  await teaching.getByRole('button', { name: '设置加签人 模拟教学经费' }).click();
  const signerDialog = page.getByRole('dialog', { name: '项目默认加签人' });
  const projectPicker = signerDialog.getByRole('combobox', { name: '项目默认加签人', exact: true });
  assert.match(await projectPicker.textContent(), /示例教学加签人 · 980001/);
  await projectPicker.selectOption('new');
  const newSignerName = signerDialog.getByLabel('加签人姓名', { exact: true });
  await signerDialog.getByRole('button', { name: '保存默认加签人' }).click();
  assert.equal(await newSignerName.evaluate((input) => input.validity.valid), false);
  assert.equal(await signerDialog.getByLabel('工号（可选）').evaluate((input) => input.required), false);
  await newSignerName.fill('模拟项目默认人');
  await signerDialog.getByRole('button', { name: '保存默认加签人' }).click();
  await signerDialog.waitFor({ state: 'hidden' });
  await teaching.getByText('默认加签人 模拟项目默认人').waitFor();
  await page.locator('.row-state', { hasText: '待匹配' }).waitFor();
  await page.locator('.row-select').uncheck();
  await teaching.getByRole('button', { name: '匹配 模拟教学经费' }).click();
  await page.locator('.row-state', { hasText: '待补充/核对' }).waitFor();
  assert.equal(await page.locator('.allocation-form').count(), 0);
  assert.equal(uiProject.projectNo, 'TEST-2026-01');
  assert.equal(await page.locator('.reason-action').innerText(), '保存事由');
  assert.equal(await page.locator('.row-select').isChecked(), false);
  await page.locator('.row-select').check();
  await page.locator('#executeSelected').click();
  assert.match(await page.locator('#executionStatus').innerText(), /请先保存或更新.*报销事由/);
  assert.equal(await reasonInput.evaluate((input) => document.activeElement === input), true);
  assert.equal(uiExecuteRequests, 0);
  const checksBeforeRefresh = uiChecks;
  const rechecked = page.waitForResponse((response) => response.url().endsWith('/api/plans') && response.request().postDataJSON()?.folder === uiGroupKey);
  await page.locator('#refreshFolders').click();
  await rechecked;
  assert.ok(uiChecks > checksBeforeRefresh);
  await page.locator('#folderRefreshStatus').filter({ hasText: '刷新完成' }).waitFor();
  const sourceRow = page.locator('.source-row').filter({ has: page.getByRole('checkbox', { name: `选择来源 ${uiFolder}`, exact: true }) });
  assert.equal(await page.locator('#receiptDirectory').textContent(), uiSourceRoot);
  assert.match(await sourceRow.innerText(), /49\.38/);
  const refresh = Promise.withResolvers();
  uiSourceRefresh = refresh.promise;
  try {
    await page.locator('#refreshFolders').click();
    await sourceRow.getByText(/4 个文件/).waitFor();
    assert.equal(await page.locator('#refreshFolders').isDisabled(), true);
    assert.match(await page.locator('#folderRefreshStatus').innerText(), /正在核对/);
    refresh.resolve();
    await sourceRow.getByText(/38\.50/).waitFor();
    await page.locator('#folderRefreshStatus').filter({ hasText: '1 个有新材料或文件变化' }).waitFor();
  } finally {
    refresh.resolve();
    uiSourceRefresh = null;
  }
  const alignment = await page.evaluate(() => {
    const panes = [...document.querySelectorAll('.match-pane')];
    return panes.map((pane) => {
      const { top, height } = pane.getBoundingClientRect();
      return [top, height];
    });
  });
  assert.equal(alignment.length, 3);
  assert.deepEqual(alignment[0], alignment[1]);
  assert.deepEqual(alignment[1], alignment[2]);
  assert.equal(await reasonInput.inputValue(), handwritten);
  await page.getByRole('button', { name: '保存事由' }).click();
  await page.getByRole('button', { name: '更新事由' }).waitFor();
  await page.locator('.reason-status', { hasText: /^已保存$/ }).waitFor();
  assert.deepEqual(uiPurposePayload, { reason: handwritten, confirmed: true });
  const revised = `${handwritten}及案例材料`;
  await reasonInput.fill(revised);
  await page.getByRole('button', { name: '更新事由' }).click();
  await page.locator('.reason-status', { hasText: /^已保存$/ }).waitFor();
  assert.deepEqual(uiPurposePayload, { reason: revised, confirmed: true });
  await page.getByRole('button', { name: '详情', exact: true }).click();
  assert.match(await page.locator('#detailContent').innerText(), /缺少已核对签字/);
  await page.getByText(`学校页面填写内容 ${revised}`).waitFor();
  await page.getByText('有提醒，可以执行', { exact: true }).waitFor();
  const signerPicker = page.locator('#detailSignerPicker select');
  assert.match(await signerPicker.locator('option:checked').textContent(), /项目默认 · 模拟项目默认人/);
  assert.ok((await signerPicker.locator('option').allTextContents()).includes('模拟项目默认人'));
  assert.match(await signerPicker.textContent(), /示例教学加签人 · 980001/);
  await signerPicker.selectOption('new');
  await page.locator('#detailSignerPicker [data-signer-name]').fill('　模拟加签人　');
  await page.getByRole('button', { name: '保存设置' }).click();
  await signerPicker.locator('option:checked', { hasText: '模拟加签人' }).waitFor({ state: 'attached' });
  assert.deepEqual(uiSignerNames, ['模拟加签人']);
  await signerPicker.selectOption('default');
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.locator('#editStatus', { hasText: '已保存' }).waitFor();
  assert.equal(uiSigner, null);
  await signerPicker.selectOption({ label: '模拟加签人' });
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.locator('#editStatus', { hasText: '已保存' }).waitFor();
  await page.locator('#closeDetail').click();
  await page.locator('.row-state', { hasText: '有提醒，可执行' }).waitFor();
  assert.match(await page.locator('.folder-figure').innerText(), /98\.76[\s\S]*核定报销/);
  await page.locator('#executeSelected').click();
  await page.locator('#executionStatus', { hasText: '批次已启动' }).waitFor();
  assert.match(await page.locator('#executionStatus').innerText(), /缺少已核对签字的签收单/);
  assert.equal(uiExecuteRequests, 1);
  await page.locator('#runClose').click();
  await page.locator('#runDrawer').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '匹配 模拟科研经费' }).click();
  const allocation = page.locator('.allocation-form');
  await allocation.waitFor();
  assert.equal(await allocation.locator('[data-invoice-total]').innerText(), '¥100.00');
  assert.equal(await allocation.locator('[data-claim-total]').innerText(), '¥98.76');
  await allocation.getByRole('textbox', { name: '模拟教学经费 报销金额' }).fill('30.25');
  assert.equal(await allocation.locator('.allocation-remainder').innerText(), '¥68.51');
  await page.getByRole('button', { name: '匹配 模拟案例经费' }).click();
  const secondShare = allocation.getByRole('textbox', { name: '模拟科研经费 报销金额' });
  await secondShare.waitFor();
  await secondShare.fill('70');
  assert.match(await allocation.locator('.allocation-status').innerText(), /最后一个项目/);
  await secondShare.fill('20.51');
  assert.equal(await allocation.locator('.allocation-remainder').innerText(), '¥48.00');
  await page.locator('#executeSelected').click();
  assert.match(await page.locator('#executionStatus').innerText(), /保存经费分配/);
  assert.equal(uiExecuteRequests, 1);
  await page.getByRole('button', { name: '查看分配' }).click();
  assert.equal(await allocation.getByRole('textbox', { name: '模拟教学经费 报销金额' }).evaluate((input) => document.activeElement === input), true);
  await allocation.getByRole('button', { name: '保存分配' }).click();
  await allocation.locator('.allocation-status', { hasText: '分配已保存' }).waitFor();
  await page.locator('#executionFeedback').waitFor({ state: 'hidden' });
  await page.locator('.row-state', { hasText: '有提醒，可执行' }).waitFor();
  assert.deepEqual(uiMatch.allocations.map(({ amountCny }) => amountCny), [3025, 2051, null]);
  assert.equal(await reasonInput.inputValue(), revised);
  if (process.env.RUNNER_TEST_SCREENSHOT) await page.screenshot({ path: process.env.RUNNER_TEST_SCREENSHOT, fullPage: true });
  await page.locator('#executeSelected').click();
  await page.locator('#executionStatus', { hasText: '批次已启动' }).waitFor();
  assert.equal(uiExecuteRequests, 2);
  await page.setViewportSize({ width: 620, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);

  const fresh = await browser.newContext();
  t.after(() => fresh.close());
  await fresh.route('**/*', (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const reopened = await fresh.newPage();
  await reopened.goto(`${origin}/runner`);
  await reopened.locator('.allocation-status', { hasText: '分配已保存' }).waitFor();
  assert.equal(await reopened.getByRole('textbox', { name: '模拟科研经费 报销金额' }).inputValue(), '20.51');
  assert.equal(await reopened.locator('.allocation-remainder').innerText(), '¥48.00');
  assert.equal(await reopened.getByLabel(`报销事由 ${uiFolder}`).inputValue(), revised);
  await reopened.getByRole('button', { name: '详情', exact: true }).click();
  assert.equal(await reopened.locator('#detailSignerPicker option:checked').textContent(), '模拟加签人');
  await reopened.locator('#closeDetail').click();
  assert.equal(await reopened.locator('.reason-action').innerText(), '更新事由');
  assert.equal(await reopened.locator('.row-select').isChecked(), false);
  assert.equal(await reopened.locator('#sourceRows input:disabled').count(), 2);
  await reopened.getByRole('button', { name: '移除 模拟科研经费' }).click();
  await reopened.locator('.allocation-remainder', { hasText: '¥68.51' }).waitFor();
  await reopened.getByRole('button', { name: '移除 模拟教学经费' }).click();
  await reopened.locator('.folder-project', { hasText: '模拟案例经费' }).waitFor();
  await reopened.getByRole('button', { name: '取消匹配' }).click();
  await reopened.locator('.folder-project').waitFor({ state: 'detached' });
  await reopened.reload();
  await reopened.locator('.row-state', { hasText: '待匹配' }).waitFor();
  assert.equal(await reopened.getByLabel(`报销事由 ${uiFolder}`).inputValue(), revised);
  assert.equal(await reopened.locator('.reason-action').innerText(), '更新事由');
  assert.equal(uiMatch, null);

  await reopened.getByRole('button', { name: '匹配 模拟教学经费' }).click();
  await reopened.locator('.folder-project', { hasText: '已保存 · 模拟教学经费' }).waitFor();
  assert.equal(await reopened.locator('.row-select').isChecked(), false);
  await reopened.getByRole('searchbox', { name: '筛选来源文件夹' }).fill('暂时隐藏来源');
  await reopened.getByRole('button', { name: '撤销合并', exact: true }).click();
  await reopened.locator('#sourceSelection', { hasText: '已退回 2 个来源文件夹' }).waitFor();
  assert.equal(await reopened.locator('.folder-row').count(), 0);
  const returned = reopened.getByLabel(`选择来源 ${uiFolder}`, { exact: true });
  await returned.check();
  assert.equal(await reopened.getByRole('button', { name: '合并为报销事项', exact: true }).isEnabled(), true);
  assert.equal(await reopened.getByLabel(`选择来源 ${uiSecondFolder}`, { exact: true }).isChecked(), false);
  await reopened.reload();
  await returned.waitFor();
  assert.equal(await returned.isEnabled(), true);
  assert.equal(await reopened.locator('.folder-row').count(), 0);
  await reopened.getByLabel('筛选办理系统').selectOption('smart');
  await returned.check();
  await reopened.getByLabel(`选择来源 ${uiSecondFolder}`, { exact: true }).check();
  await reopened.getByRole('button', { name: '合并为报销事项', exact: true }).click();
  const offlineDialog = reopened.getByRole('dialog', { name: '办理方式' });
  await offlineDialog.getByLabel('办理系统', { exact: true }).selectOption('legacy');
  await offlineDialog.getByRole('button', { name: '合并', exact: true }).click();
  await reopened.locator('.folder-route', { hasText: '日常线下报销' }).waitFor();
  assert.equal(await reopened.getByLabel('筛选办理系统').inputValue(), 'legacy');
  await reopened.reload();
  await reopened.getByLabel('筛选办理系统').selectOption('legacy');
  await reopened.locator('.folder-route', { hasText: '日常线下报销' }).waitFor();
});
