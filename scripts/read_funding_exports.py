import contextlib
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from hashlib import sha256
import hmac
import io
import json
import os
from pathlib import Path
import re
import sys


LEDGER_BUDGET_STATES = ('已到账', '已确认', '已确认额度', '已授权', '已授权额度', '仅登记预算')


def text(value):
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip() if value is not None else ''


def cents(value):
    try:
        amount = Decimal(re.sub(r'[\s,，¥￥元]', '', text(value)))
        return int((amount * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError, OverflowError):
        return None


def day(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()[:10] if value.year > 1900 else ''
    match = re.match(r'^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})', text(value))
    if match:
        try:
            parsed = date(*map(int, match.groups()))
            return parsed.isoformat() if parsed.year > 1900 else ''
        except ValueError:
            pass
    return ''


def sheets(path):
    if path.suffix.lower() == '.xls':
        import xlrd
        log = io.StringIO()
        with contextlib.redirect_stdout(log):
            book = xlrd.open_workbook(path, logfile=log, on_demand=True)
        try:
            for sheet in book.sheets():
                rows = [[xlrd.xldate_as_datetime(cell.value, book.datemode) if cell.ctype == xlrd.XL_CELL_DATE
                         else cell.value for cell in sheet.row(index)] for index in range(sheet.nrows)]
                yield sheet.name, rows
        finally:
            book.release_resources()
    else:
        from openpyxl import load_workbook
        book = load_workbook(path, read_only=True, data_only=True)
        try:
            for sheet in book.worksheets:
                yield sheet.title, list(sheet.values)
        finally:
            book.close()


def table(rows, headers):
    for index, row in enumerate(rows[:15]):
        columns = [re.sub(r'\s+', '', text(value)) for value in row]
        if all(column in columns for column in headers):
            for row_no, values in enumerate(rows[index + 1:], index + 2):
                yield row_no, dict(zip(columns, values))
            return
    raise ValueError('找不到所需表头：' + '、'.join(headers))


def first(row, *names):
    return next((row[name] for name in names if text(row.get(name))), None)


def ledger_rows(sheet, rows):
    for row_no, row in table(rows, ('台账编号', '项目名称', '进账状态', '项目金额', '学校项目编号')):
        ledger_no = text(row.get('台账编号'))
        status = text(row.get('进账状态'))
        if not ledger_no or status not in LEDGER_BUDGET_STATES:
            continue
        handling_mode = text(row.get('报销归属'))
        note = text(row.get('规则摘要'))
        completed = handling_mode == '托人报销' and '已完成报销' in (part.strip() for part in re.split(r'[。；，\n]+', note))
        yield {'ledgerNo': ledger_no, 'name': text(row.get('项目名称')), 'projectNo': text(row.get('学校项目编号')),
               'budgetCny': cents(row.get('项目金额')), 'handlingMode': handling_mode,
               'handlingPerson': text(row.get('关联人员')), 'handlingStatus': '已完成' if completed else '',
               'budgetNote': note if status == '仅登记预算' else '', 'sheet': sheet, 'row': row_no}


def reimbursement_rows(sheet, rows):
    for row_no, row in table(rows, ('报销单号', '经费项目', '支付金额')):
        finance_id = text(row.get('报销单号'))
        if not finance_id:
            continue
        status = text(first(row, '单据状态', '状态'))
        item = text(first(row, '支出项目', '支出项', '支出科目', '费用类型'))
        business = text(row.get('业务类型'))
        payment = cents(row.get('支付金额'))
        actual = cents(first(row, '实际报销金额', '实际报销/借款金额', '实际凭证总金额'))
        amount = payment if business == '贸大出行' or actual is None else actual
        if re.search(r'作废|撤回|撤销|驳回|退回|草稿|未提交|取消|删除|终止|失败', status):
            state = 'excluded'
        elif status in ('已制单', '已记账', '已入账', '已支付', '支付成功', '支付完成', '付款完成', '已付款', '已报销', '报销完成'):
            state = 'booked'
        else:
            state = 'pending'
            if not actual:
                amount = payment
        yield {'financeId': finance_id, 'status': status, 'state': state, 'amountCny': amount,
               'projectText': text(row.get('经费项目')), 'item': item, 'business': business,
               'date': day(row.get('凭证日期')) or day(first(row, '预约时间', '预约日期', '提交时间', '申请日期')),
               'reason': text(first(row, '报销事由', '报销/借款事由')), 'sheet': sheet, 'row': row_no}


def labor_rows(sheet, rows):
    for row_no, row in table(rows, ('单据编号', '经费项目代码', '应发合计')):
        finance_id = text(row.get('单据编号'))
        if not finance_id:
            continue
        voucher = text(row.get('凭证编号'))
        paid_date = day(row.get('发放日期'))
        project_no = text(row.get('经费项目代码'))
        recipient = text(first(row, '工号/人员号', '证件号', '人员'))
        reason = text(row.get('发放内容'))
        key = sha256('\0'.join((finance_id, project_no, recipient, reason)).encode()).hexdigest()
        status = '已发放' if paid_date else '已制单' if voucher else '待发放'
        yield {'financeId': finance_id, 'laborKey': key, 'state': 'booked' if paid_date or voucher else 'pending',
               'status': status, 'amountCny': cents(row.get('应发合计')),
               'projectNo': project_no, 'projectName': text(row.get('经费项目名称')),
               'reason': reason, 'date': day(row.get('凭证日期')) or paid_date, 'sheet': sheet, 'row': row_no}


def payroll_people(root, category, key):
    files = [root / (category + '导出' + suffix) for suffix in ('.xlsx', '.xls')]
    available = [file for file in files if file.is_file()]
    if not available:
        return []
    _, rows = next(sheets(max(available, key=lambda file: file.stat().st_mtime_ns)))
    people = {}
    for _, row in table(rows, ('单据编号', '人员', '工号/人员号', '发放日期')):
        name = ' '.join(text(row.get('人员')).split())
        paid = day(row.get('发放日期'))
        if not name or not text(row.get('单据编号')) or not paid:
            continue
        code = text(row.get('工号/人员号')).upper()
        kind = 'code'
        if not re.fullmatch(r'[A-Z0-9-]{4,40}', code):
            code = text(row.get('证件号')).upper()
            kind = 'certificate'
        if not re.fullmatch(r'[A-Z0-9-]{4,40}', code) or not re.fullmatch(r'[A-Z0-9]{4}', code[-4:]):
            continue
        if kind == 'certificate' and isinstance(row.get('证件号'), (int, float)) and len(code) > 15:
            continue
        identity = hmac.new(key, '\0'.join((category, kind, code)).encode(), 'sha256').hexdigest()
        if identity in people and people[identity]['paidAt'] >= paid:
            continue
        people[identity] = {'key': identity, 'category': category, 'name': name, 'identityTail': code[-4:],
                            'organization': text(row.get('所属部门'))[:100], 'paidAt': paid, 'source': 'history'}
    return list(people.values())


def read_exports(root, selected_year=''):
    year = selected_year if re.fullmatch(r'20\d{2}', selected_year) else root.name if re.fullmatch(r'20\d{2}', root.name) else ''
    ledgers = sorted(root.glob('20[0-9][0-9]年度进账与报销台账.xlsx')) if not year else []
    if len(ledgers) == 1:
        year = ledgers[0].name[:4]
    labor_categories = {'学生劳务费', '校外人员劳务费'}
    for path in root.iterdir():
        match = re.fullmatch(r'(.+(?:劳务费|劳务报酬|酬金)|薪酬申报-.+)导出\.xlsx?', path.name)
        if match and path.is_file():
            labor_categories.add(match.group(1))
    inputs = [
        ('budget', [f'{year}年度进账与报销台账.xlsx'] if year else [], ledger_rows),
        ('smart', ['报销单统计.xlsx', '报销单统计.xls'], reimbursement_rows),
        ('legacy', ['报销单查询.xls', '报销单查询.xlsx'], reimbursement_rows),
    ]
    inputs.extend(('labor', [f'{category}导出.xls', f'{category}导出.xlsx'], labor_rows) for category in sorted(labor_categories))
    sources, records, budgets = [], [], []
    for kind, names, parse in inputs:
        source = {'kind': kind, 'file': names[0] if names else '年度进账与报销台账.xlsx', 'state': 'missing'}
        sources.append(source)
        matches = [root / name for name in names if (root / name).is_file()]
        if not matches:
            if kind == 'budget' and len(ledgers) > 1:
                source.update(state='error', message='当前目录有多个年度台账，请选定一个年度目录')
            continue
        try:
            path = max(matches, key=lambda item: item.stat().st_mtime_ns)
            source.update(file=path.name, updatedAt=datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat())
            workbook = list(sheets(path))
            sheet, rows = next(((name, rows) for name, rows in workbook if name == '项目清单'), ('项目清单', [])) if kind == 'budget' else workbook[0]
            parsed = [{'file': path.name, 'kind': kind, **row} for row in parse(sheet, rows)]
        except ImportError:
            source.update(state='error', message='当前 Python 缺少读取 Excel 的组件')
            continue
        except ValueError as error:
            source.update(state='error', message=str(error) if str(error).startswith('找不到所需表头') else '表格格式有误')
            continue
        except Exception:
            source.update(state='error', message='文件暂不可读或格式有误')
            continue
        selected = [row for row in parsed if not year or not row.get('date') or row['date'].startswith(year)]
        source.update(state='read', rowCount=len(selected), excludedYears=len(parsed) - len(selected),
                      lastDate=max((row.get('date', '') for row in selected), default=''))
        (budgets if kind == 'budget' else records).extend(selected)
    return {'year': year, 'sources': sources, 'budgets': budgets, 'records': records}


if __name__ == '__main__':
    if sys.argv[1] == '--payroll-people':
        print(json.dumps(payroll_people(Path(sys.argv[2]), sys.argv[3], bytes.fromhex(os.environ['REIMBURSEMENT_PAYROLL_KEY'])), ensure_ascii=False))
    elif sys.argv[1] in ('--register', '--labor'):
        mode, path = sys.argv[1], Path(sys.argv[2])
        workbook = list(sheets(path))
        records = list((labor_rows if mode == '--labor' else reimbursement_rows)(*workbook[0]))
        print(json.dumps(records, ensure_ascii=False))
    else:
        print(json.dumps(read_exports(Path(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else ''), ensure_ascii=False))
