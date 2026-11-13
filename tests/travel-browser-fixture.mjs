export function travelPortal() {
  return `<!doctype html><meta charset="utf-8">
    <div class="el-submenu"><div class="el-submenu__title">智能网报5.0</div>
      <ul hidden><li class="el-menu-item"><span>我要报销</span></li></ul>
    </div>
    <iframe title="模拟报销" style="width:100%;height:85vh" hidden></iframe>
    <script>
      const list = document.querySelector('ul');
      const menu = document.querySelector('.el-submenu');
      menu.querySelector('div').onclick = () => {
        list.hidden = !list.hidden;
        menu.setAttribute('aria-expanded', String(!list.hidden));
      };
      menu.querySelector('li span').onclick = () => {
        const frame = document.querySelector('iframe');
        frame.src = '/ClaimsPublicPCWeb/fast-reimbursement';
        frame.hidden = false;
      };
    </script>`;
}

export function travelSchoolForm(plan, pathname) {
  const config = {
    pathname,
    project: plan.project,
    rows: plan.rows.map(({ invoiceNumber, invoiceFile, invoiceAmountCny, travelKind }) => ({ invoiceNumber, invoiceFile, invoiceAmountCny, travelKind })),
    reason: plan.reason,
    signer: plan.signer,
    facts: plan.travel.facts,
    ticketCny: plan.invoiceTotalCny,
    application: 'B2026-SIM-001',
    draft: 'TRAVEL-SIM-001',
  };
  return `<!doctype html><meta charset="utf-8"><main></main><script>
    const cfg = ${JSON.stringify(config).replaceAll('<', '\\\\u003c')};
    const fields = ['业务单号', '名称', '经办人', '出差开始日期', '出差结束日期', '出差地点'];
    const traveler = cfg.facts.travelers.map(({name}) => name).join('、');
    const read = () => JSON.parse(sessionStorage.getItem('travel-simulation') || 'null');
    const state = read() || {
      application: '', project: false, files: [], reason: '', lodging: String(cfg.rows.find(r => r.travelKind === 'lodging').invoiceAmountCny / 100),
      meal: '0', local: '0', allocated: '0', purpose: '', payment: '', bank: false, uploads: 0, associations: 0, submitClicks: 0, signerConfirmClicks: 0,
    };
    let phase = cfg.pathname.includes('travel-reimbursement') ? 'travel' : cfg.pathname.endsWith('/filling') ? 'pay' :
      cfg.pathname.endsWith('/reimburse') ? 'reason' : 'start';
    const screen = { business: false, page: 1, choice: false, project: false, device: false, upload: false,
      editLodging: false, editSubsidy: false, subsidy: phase === 'travel', chooseSigner: false, signer: false };
    const main = document.querySelector('main');
    const store = () => sessionStorage.setItem('travel-simulation', JSON.stringify(state));
    const money = n => Number(n).toFixed(2);
    const cents = v => Math.round(Number(v) * 100);
    const lodgingInvoice = cfg.rows.find(r => r.travelKind === 'lodging');
    const total = () => (cfg.ticketCny - lodgingInvoice.invoiceAmountCny + cents(state.lodging) + cents(state.meal) + cents(state.local)) / 100;
    const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    const button = (name, action, attrs = '') => '<button data-action="' + action + '" ' + attrs + '>' + name + '</button>';
    const input = (key, attrs = '') => '<input data-field="' + key + '" value="' + esc(state[key] ?? '') + '" ' + attrs + '>';
    const table = (heads, rows) => '<table><thead><tr>' + heads.map(x => '<th><div class="cell">' + x + '</div></th>').join('') + '</tr></thead><tbody>' +
      rows.map(cells => '<tr>' + cells.map(x => '<td><div class="cell">' + x + '</div></td>').join('') + '</tr>').join('') + '</tbody></table>';
    const toolbar = (title, action) => '<div class="fast-reimbursement-cardFlex"><div class="fast-reimbursement-cardHead"><div>' + title + '</div></div>' + button('添加', action) + '</div>';
    const business = () => toolbar('业务单信息', 'business') + (state.application ? table(fields.slice(0, 3), [[state.application, '国内出差申请', traveler]]) : '');
    const budget = () => toolbar('经费预算信息', 'projects') + '<div class="fast-reimbursement-table">' + table(['项目编号','项目名称','项目余额/授权金额'],
      state.project ? [[esc(cfg.project.projectNo), esc(cfg.project.projectName), '10,000.00']] : []) + '</div>';
    const images = () => '<div class="fast-reimbursement-divBottom">' + toolbar('票据影像', 'images') +
      '<div class="theSecondStep-top"><div class="theSecondStep-divFlex">' +
      state.files.map(name => '<div title="' + esc(name) + '">' + esc(name) + '</div>').join('') + '</div></div>' +
      (state.files.length ? '<p>当前票据总张数：' + cfg.rows.length + '张 当前票据总金额：￥' + money(cfg.ticketCny / 100) +
        ' 元 当前附件总张数：' + (state.files.length - cfg.rows.length) + '张</p>' + cfg.rows.map(r => '<p>' + r.invoiceNumber + '</p>').join('') : '') + '</div>';
    const orders = () => {
      const other = ['B2026-SIM-002', '国内出差申请', traveler, cfg.facts.startDate.replace('-08-', '-09-'), cfg.facts.endDate.replace('-08-', '-09-'), cfg.facts.destination];
      const match = [cfg.application, '国内出差申请', traveler, cfg.facts.startDate, cfg.facts.endDate, cfg.facts.destination];
      const results = screen.searched ? [other, match].filter(r => r[0] === screen.searched) : screen.page === 1 ? [other] : [match];
      return '<div class="el-dialog" role="dialog"><h2>选择业务单</h2><input readonly placeholder="请选择业务单类型" value="' + (screen.choice ? '国内出差申请' : '') + '" data-action="show-options">' +
        (screen.options ? '<div role="listbox"><button role="option" data-action="type">国内出差申请</button></div>' : '') +
        '<input placeholder="请输入业务单号" id="application-query">' + button('查询', 'search') +
        table(['', ...fields], screen.choice ? results.map(r => ['<input type="checkbox" value="' + r[0] + '">', ...r.map(esc)]) : []) +
        button('下一页', 'next-order', screen.page === 1 && !screen.searched ? '' : 'disabled') + button('确认', 'attach') + '</div>';
    };
    const allowance = () => {
      const method = (label, active) => '<div class="el-form-item"><span>' + label + '：</span>' +
        '<label><input type="radio" name="' + label + '"' + (active ? ' checked' : '') + '>直接补贴</label>' +
        '<label><input type="radio" name="' + label + '"' + (active ? '' : ' checked') + '>实报实销</label></div>';
      const row = screen.editSubsidy ? [input('local'), input('meal'), button('完成', 'finish-subsidy')] :
        [money(state.local), money(state.meal), button('编辑', 'edit-subsidy')];
      return '<h2>出差人员明细</h2><p>' + esc(traveler) + '</p><h2>补贴金额</h2><h3>补贴费用明细</h3>' +
        (state.subsidy ? table(['出差人', '交通补贴金额', '伙食补贴金额', '操作'], [[esc(traveler), ...row]]) : '') +
        (screen.subsidy ? '<div class="el-dialog" role="dialog"><h3>补贴方式</h3>' + method('交通') + method('伙食') + method('住宿') + button('确认', 'subsidy') + '</div>' : '');
    };
    const payment = () => '<p>' + esc(cfg.project.projectNo) + '</p><p>报销事由 ' + esc(state.reason) + '</p><p>报销金额：' + money(total()) + '</p>' +
      table(fields.slice(0, 3), [[state.application, '国内出差申请', traveler]]) +
      '<div class="part-box"><div class="fast-reimbursement-cardHead"><div>报销支出费用明细</div></div>' +
      '<div class="project-box"><div class="project-head"><span class="project-name">' + esc(cfg.project.projectNo + '-' + cfg.project.projectName) + '</span></div>' +
      '<div role="tab" aria-selected="true">教学</div><div class="el-tab-pane">' +
      '<div class="el-collapse-item is-active"><button class="el-collapse-item__header" aria-expanded="true"><span class="subject">国内差旅费</span></button>' +
      '<div class="detail">' + input('allocated', 'placeholder="请输入金额"') + '<span class="right-message">' + money(total()) + '</span>' +
      input('purpose', 'placeholder="请输入用途"') + '</div></div></div></div>' +
      '<p class="total-money">可分配报销金额：￥' + money(total()) + '</p><p class="allocate-money" id="allocation">待分配金额：￥' + money(total() - Number(state.allocated)) + '</p></div>' +
      '<section><h2>支付信息</h2>' + (state.bank ? '<p>教职工银行-建设银行</p>' + input('payment', 'placeholder="请输入金额"') +
      '<p id="pay-left">待支付金额：￥' + money(total() - Number(state.payment)) + '</p>' : button('添加支付类型', 'bank')) +
      button('保存并下一步', 'save-pay') + '</section>' +
      (screen.bank ? button('教职工银行-建设银行', 'select-bank') : '') +
      (screen.signer ? '<div class="el-dialog" role="dialog"><h2>请选择线上审批加签人</h2>' + button('加签人', 'find-signer') +
        '<p>' + (state.signer ? esc(cfg.signer.employeeNo + '—' + cfg.signer.name) : '') + '</p>' + button('确认', 'confirm-signer') + '</div>' : '') +
      (screen.chooseSigner ? '<div class="el-dialog" role="dialog"><h2>查询</h2><input placeholder="请输入姓名">' + button('查询', 'query-signer') +
        table(['','姓名','工号'], [['<input type="checkbox">', esc(cfg.signer.name), esc(cfg.signer.employeeNo)]]) + button('确认', 'pick-signer') + '</div>' : '');
    function render() {
      let body = phase === 'start' ? budget() + images() + button('下一步', 'next') : '';
      if (phase === 'type') body += '<p>请选择报销类别</p>' + button('日常报销', 'wrong-type') + button('国内差旅', 'travel-type') + button('单据填报', 'start-travel');
      if (phase === 'reason') body += '<h1>单据填报-国内差旅</h1>' + input('reason', 'role="textbox" aria-autocomplete="list"') + business() + button('保存并下一步', 'save-reason');
      if (phase === 'travel') {
        body += '<h1>国内差旅报销</h1><p>城际交通费用</p>' + table(['交通工具','金额'], [['飞机', '1,328.00']]) +
          '<h2>住宿费用</h2>' + table(['类型','金额','操作'], [['住宿费用', esc(lodgingInvoice.invoiceAmountCny / 100), ''],
            ['住宿费用费用合计 :', '', screen.editLodging ? input('lodging', 'type="number"') + button('完成', 'finish-lodging') : money(state.lodging) + button('编辑', 'edit-lodging')]]) +
          allowance() + button('保存并下一步', 'save-travel');
      }
      if (phase === 'pay') body += payment();
      if (phase === 'confirm') body += payment() + '<div class="el-dialog"><h2>确认提交报销单</h2>' + button('提交预审', 'submit') + '</div>';
      if (screen.business) body += orders();
      if (screen.project) body += '<div class="el-dialog"><h3>请选择预算项目</h3>' + table(['', '项目编号', '项目名称'],
        [['<input type="checkbox">', esc(cfg.project.projectNo), esc(cfg.project.projectName)]]) + button('确认','add-project') + '</div>';
      if (screen.device) body += button('从本设备选择', 'device');
      if (screen.upload) body += '<div class="el-dialog">' + button('点击上传','choose-file') + '<input type="file" hidden multiple id="files">' + button('上传', 'upload') + '</div>';
      main.innerHTML = '<p>报销单号：' + cfg.draft + '</p>' + body;
    }
    document.addEventListener('input', (event) => {
      const key = event.target.dataset.field;
      if (!key) return;
      state[key] = event.target.value;
      if (key === 'allocated') document.querySelector('#allocation').textContent = '待分配金额：￥' + money(total() - Number(state.allocated));
      if (key === 'payment') document.querySelector('#pay-left').textContent = '待支付金额：￥' + money(total() - Number(state.payment));
      store();
    });
    document.addEventListener('click', (event) => {
      const action = event.target.dataset.action;
      if (!action) return;
      if (action === 'projects') screen.project = true;
      if (action === 'add-project' && document.querySelector('.el-dialog input:checked')) { state.project = true; screen.project = false; }
      if (action === 'images') screen.device = true;
      if (action === 'device') { screen.device = false; screen.upload = true; }
      if (action === 'choose-file') { document.querySelector('#files').click(); return; }
      if (action === 'upload') {
        state.files.push(...Array.from(document.querySelector('#files').files, ({name}) => name));
        state.uploads++;
        screen.upload = false;
      }
      if (action === 'next') phase = 'type';
      if (action === 'travel-type') { screen.travel = true; event.target.setAttribute('aria-pressed', 'true'); return; }
      if (action === 'start-travel' && screen.travel) location.href = '/ClaimsPublicPCWeb/reimburse?id=' + cfg.draft;
      if (action === 'business') screen.business = true;
      if (action === 'show-options') screen.options = true;
      if (action === 'type') { screen.options = false; screen.choice = true; }
      if (action === 'next-order') screen.page++;
      if (action === 'search') screen.searched = document.querySelector('#application-query').value;
      if (action === 'attach') {
        state.application = document.querySelector('.el-dialog input:checked')?.value || '';
        if (state.application) { state.associations++; screen.business = false; }
      }
      if (action === 'save-reason' && state.application && state.reason) location.href = '/TravelPCWeb/travel-reimbursement?id=' + cfg.draft;
      if (action === 'edit-lodging') screen.editLodging = true;
      if (action === 'finish-lodging') screen.editLodging = false;
      if (action === 'subsidy') {
        const mode = name => [...document.querySelectorAll('input[name="' + name + '"]')].findIndex(x => x.checked);
        if (mode('交通') === 0 && mode('伙食') === 0 && mode('住宿') === 1) {
          state.subsidy = true; state.meal = '450'; state.local = '350'; screen.subsidy = false;
        }
      }
      if (action === 'edit-subsidy') screen.editSubsidy = true;
      if (action === 'finish-subsidy') screen.editSubsidy = false;
      if (action === 'save-travel' && !screen.editLodging && !screen.editSubsidy) location.href = '/ClaimsPublicPCWeb/filling?id=' + cfg.draft;
      if (action === 'bank') screen.bank = true;
      if (action === 'select-bank') { state.bank = true; screen.bank = false; }
      if (action === 'save-pay' && Number(state.payment) === total()) screen.signer = true;
      if (action === 'find-signer') screen.chooseSigner = true;
      if (action === 'query-signer') return;
      if (action === 'pick-signer' && document.querySelector('.el-dialog input:checked')) { screen.chooseSigner = false; state.signer = true; }
      if (action === 'confirm-signer') { state.signerConfirmClicks++; screen.signer = false; phase = 'confirm'; }
      if (action === 'submit') state.submitClicks++;
      store();
      render();
    });
    window.travelSimulation = () => ({ ...read(), phase });
    render();
  </script>`;
}
