export function travelInvoiceKind(document) {
  const text = document?.text || '';
  if (/(?:代订|预订)机票|\*[^*\n]+\*[^\n]*(?:航空客运|客运机票|飞机票)|航空运输电子客票|电子客票行程单/.test(text)) return 'flight';
  if (/铁路电子客票|铁路运输|铁路车票|\*[^*\n]+\*[^\n]*火车票/.test(text)) return 'rail';
  if (/(?:代订|预订)住宿|\*[^*\n]+\*[^\n]*(?:住宿|房费|酒店服务)/.test(text)) return 'lodging';
  return null;
}

const sellerOf = (text) => (text.match(/销\s*名\s*称[：:]\s*([^\s*]+(?:公司|酒店|宾馆|中心))/)?.[1] || '').normalize('NFKC');
const payeeOf = (text) => (text.match(/(?:对方户名|收款方全称|收款方名称|商户全称|商户名称)[：:\s]*([^\s*]+)/)?.[1] || '').normalize('NFKC');

export function matchTravelPayments(invoices, payments, linksForInvoice, matchesOrder) {
  const groups = new Map();
  for (const invoice of invoices) {
    const seller = sellerOf(invoice.text || '');
    const kind = travelInvoiceKind(invoice);
    if (!seller || !kind || !invoice.date || !Number.isSafeInteger(invoice.invoiceAmountCny) || invoice.invoiceAmountCny <= 0) continue;
    const order = invoice.orderNumber || invoice.file.name.match(/订单(\d{15,40})(?=[-—_.（(])/u)?.[1];
    const key = JSON.stringify([seller, kind, invoice.date, kind === 'flight' && order ? order : invoice.invoiceNumber]);
    const group = groups.get(key) || { seller, invoices: [], amount: 0 };
    group.invoices.push(invoice);
    group.amount += invoice.invoiceAmountCny;
    groups.set(key, group);
  }
  const authoritative = new Map(invoices.map((invoice) => {
    const linked = linksForInvoice(invoice);
    const orderNumbers = new Set(invoice.orderNumbers || (invoice.orderNumber ? [invoice.orderNumber] : []));
    return [invoice.invoiceNumber, payments.filter((payment) =>
      payment.names.some((name) => linked.payment.includes(name)) || matchesOrder(payment, orderNumbers))];
  }));
  const proposed = [];
  for (const group of groups.values()) {
    const numbers = new Set(group.invoices.map(({ invoiceNumber }) => invoiceNumber));
    const matches = payments.filter((payment) => payment.amount === group.amount &&
      payeeOf(payment.document.text || '') === group.seller && payment.document.date &&
      group.invoices.every((invoice) => payment.document.date <= invoice.date));
    if (matches.length !== 1) continue;
    const [payment] = matches;
    if (group.invoices.some(({ invoiceNumber }) => authoritative.get(invoiceNumber).some((other) => other !== payment)) ||
        [...authoritative].some(([number, linked]) => !numbers.has(number) && linked.includes(payment))) continue;
    proposed.push({ payment, invoices: group.invoices });
  }
  return new Map(proposed.filter(({ payment }) => proposed.filter((group) => group.payment === payment).length === 1)
    .flatMap(({ payment, invoices }) => invoices.map(({ invoiceNumber }) => [invoiceNumber, payment])));
}

export const isAirfareComparison = (text) => /政府采购机票(?:管理|服务)(?:网站|平台)|gpticket\.org/i.test(text || '') && !/查验单(?:号|编号)/.test(text);

const flightNumber = (value) => value?.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
const legKey = (date, flight) => date && flight ? date + '/' + flightNumber(flight) : '';
const flightPattern = /(?<![A-Z0-9])(?:[A-Z][A-Z0-9]|[0-9][A-Z])\s*\d{3,4}(?!\d)/gi;
export const datePattern = /20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}(?:日|\b)/g;

export function travelDate(value, year = '') {
  const parts = String(value || '').match(/(?:(20\d{2})\s*[-/.年]\s*)?(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:日|\b)/);
  if (!parts || !(parts[1] || year)) return '';
  const iso = [parts[1] || year, parts[2].padStart(2, '0'), parts[3].padStart(2, '0')].join('-');
  const timestamp = Date.parse(iso + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === iso ? iso : '';
}

function datedFlights(text, year) {
  const legs = [];
  const date = /(?:(20\d{2})\s*[-/.年]\s*)?\d{1,2}\s*[-/.月]\s*\d{1,2}(?:日|\b)/g;
  let current = '';
  for (const line of text.split('\n')) {
    // Remove departure and arrival times before looking for the nearest travel date.
    const fields = line.replace(/\d{1,2}:\d{2}/g, '');
    for (const token of [...fields.matchAll(date), ...fields.matchAll(flightPattern)].sort((a, b) => a.index - b.index)) {
      if (/^[0-9]/.test(token[0]) && !/^[0-9][A-Z]/i.test(token[0])) current = travelDate(token[0], year);
      else if (current) legs.push(legKey(current, token[0]));
    }
  }
  return [...new Set(legs)];
}

export function travelEvidence(documents, facts) {
  const flights = facts.segments.filter(({ transportMode }) => /飞机|航班|航空/.test(transportMode));
  const expected = new Set(flights.map(({ travelDate: date, serviceNumber }) => legKey(date, serviceNumber)));
  const year = facts.startDate?.slice(0, 4);
  const comparisons = [];
  const itineraries = [];
  const hotelDetails = [];
  const inspections = [];
  for (const { file, text, invoiceNumber } of documents) {
    if (invoiceNumber || !/\.(?:pdf|png|jpe?g|webp)$/i.test(file.name)) continue;
    if (isAirfareComparison(text)) {
      const selected = text.search(/已选择的?(?:去程|返程|回程)?航班/);
      const legs = datedFlights(selected >= 0 ? text.slice(selected) : text, '');
      const amount = text.match(/(?:总价(?:格)?|合计(?:金额)?|应付金额)\s*[：:]?\s*[¥￥]?\s*([\d,]+(?:\.\d{1,2})?)/)?.[1];
      const amountCny = amount && Math.round(Number(amount.replaceAll(',', '')) * 100);
      if (legs.length && legs.every((leg) => expected.has(leg)) && Number.isSafeInteger(amountCny) && amountCny > 0) comparisons.push({ name: file.name, legs, amountCny });
      continue;
    }
    if (/政府采购机票.*查验单|机票查验单(?:号|编号)/s.test(text)) inspections.push(file.name);
    if (datedFlights(text, year).some((leg) => expected.has(leg))) itineraries.push(file.name);
    if (/入住|入离日期/.test(text) && /退房|离店|入离日期/.test(text)) {
      const dates = new Set([...text.matchAll(datePattern)]
        .map(([date]) => travelDate(date)));
      if (facts.lodgingStays.some((stay) => dates.has(stay.checkInDate) && dates.has(stay.checkOutDate))) hotelDetails.push(file.name);
    }
  }
  const uniqueFares = [...Map.groupBy(comparisons, ({ legs }) => [...legs].sort().join(',')).values()]
    .map((options) => options.sort((a, b) => a.amountCny - b.amountCny)[0]);
  const wholeTrip = uniqueFares.find(({ legs }) => legs.length === expected.size);
  const used = new Set(uniqueFares.flatMap(({ legs }) => legs));
  const combined = used.size === expected.size && uniqueFares.reduce((sum, { legs }) => sum + legs.length, 0) === used.size;
  return {
    comparisons: wholeTrip ? [wholeTrip] : combined ? uniqueFares : [],
    itineraries, hotelDetails, inspections,
  };
}
