import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { askCodex } from './codex.mjs';
import { TRAVEL_ROLE_OPTIONS, calculateTravelAllowance, calculateLodgingLimit, travelEntitlement } from './travel-policy.mjs';
import { isAirfareComparison, travelDate, travelEvidence, travelInvoiceKind } from './travel-evidence.mjs';
import { redactModelText } from './model-input.mjs';

export const DEFAULT_TRAVEL_PROFILE = { role: 'other', fundType: 'budget' };

export function travelRoleOptions() {
  return Object.entries(TRAVEL_ROLE_OPTIONS).map(([value, item]) => ({ value, label: item.label }));
}

async function extractTravelFacts({ appDir, folder, candidates, docByName, fingerprint }) {
  const cacheDir = join(appDir, '.runtime', 'cache', encodeURIComponent(folder));
  const cacheFile = join(cacheDir, `travel-${fingerprint}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (cached.facts) return cached.facts;
  } catch {}
  const manifest = candidates.filter(({ name }) => !isAirfareComparison(docByName.get(name)?.text)).map((file, index) => {
    const doc = docByName.get(file.name);
    const text = redactModelText(doc?.text).replace(/\s+/g, ' ').trim().slice(0, 600);
    return { name: `附件${index + 1}`, content: text || '（无文字内容）' };
  });
  const prompt = `你是学校财务差旅报销的材料识别助手。下面是差旅报销的附件及其文字内容。
请完整提取差旅事实，只输出严格 JSON，不要输出任何其他文字。规则：
- 附件没有明确显示的信息一律填 null，绝不推测；布尔字段只有附件有明确依据才填 true 或 false；
- 日期统一写 YYYY-MM-DD；时间精确到分钟写 YYYY-MM-DD HH:mm；金额写数字（单位：元）；
- segments 逐段记录每张机票/车票/行程单；lodgingStays 逐笔记录住宿；
- flightPurchaseChannel：政府采购机票填 "government"，携程/飞猪等第三方平台填 "third_party"，没有机票填 "not_applicable"，有机票但渠道不明填 "unknown"；
输出格式：
{"destination":"目的地","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","travelerCount":1,"hostCoversMeals":null,"hostCoversLocalTransport":null,"noLocalTransportAllowance":null,"longTermResearch":null,"segments":[{"departure":"出发地","destination":"到达地","travelDate":"YYYY-MM-DD","departureDatetime":"YYYY-MM-DD HH:mm","arrivalDatetime":"YYYY-MM-DD HH:mm","serviceNumber":"航班号或车次","transportMode":"飞机|火车|其他","ticketAmount":0}],"lodgingStays":[{"location":"入住地","checkInDate":"YYYY-MM-DD","checkOutDate":"YYYY-MM-DD","amount":0,"guestCount":1}],"flightPurchaseChannel":"not_applicable"}
文件清单：
${JSON.stringify(manifest, null, 2)}`;
  const text = await askCodex({ prompt, cwd: appDir, purpose: 'travel', timeoutMs: 180000 });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI 未返回差旅 JSON');
  const facts = JSON.parse(match[0]);
  delete facts.travelers;
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ fingerprint, facts }), { mode: 0o600 });
  return facts;
}

const toCny = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value) * 100) : null);
const toBool = (value) => (value === true ? true : value === false ? false : null);

function normalizeFacts(raw) {
  const facts = raw && typeof raw === 'object' ? raw : {};
  return {
    destination: typeof facts.destination === 'string' && facts.destination.trim() ? facts.destination.trim() : null,
    startDate: travelDate(facts.startDate) || null,
    endDate: travelDate(facts.endDate) || null,
    travelerCount: Number.isInteger(facts.travelerCount) && facts.travelerCount > 0 ? facts.travelerCount : null,
    travelers: Array.isArray(facts.travelers) ? facts.travelers.filter((item) => item?.name).map((item) => ({ name: String(item.name) })) : [],
    hostCoversMeals: toBool(facts.hostCoversMeals),
    hostCoversLocalTransport: toBool(facts.hostCoversLocalTransport),
    noLocalTransportAllowance: toBool(facts.noLocalTransportAllowance),
    longTermResearch: toBool(facts.longTermResearch),
    segments: (Array.isArray(facts.segments) ? facts.segments : []).map((segment) => ({
      departure: String(segment?.departure || ''), destination: String(segment?.destination || ''),
      travelDate: travelDate(segment?.travelDate) || null, departureDatetime: segment?.departureDatetime || null, arrivalDatetime: segment?.arrivalDatetime || null,
      serviceNumber: String(segment?.serviceNumber || ''), transportMode: String(segment?.transportMode || ''),
      ticketAmountCny: toCny(segment?.ticketAmount),
    })),
    lodgingStays: (Array.isArray(facts.lodgingStays) ? facts.lodgingStays : []).map((stay) => ({
      location: String(stay?.location || ''), checkInDate: travelDate(stay?.checkInDate) || null, checkOutDate: travelDate(stay?.checkOutDate) || null,
      amountCny: toCny(stay?.amount), guestCount: Number.isInteger(stay?.guestCount) && stay.guestCount > 0 ? stay.guestCount : null,
    })),
    flightPurchaseChannel: ['government', 'third_party', 'not_applicable', 'unknown'].includes(facts.flightPurchaseChannel) ? facts.flightPurchaseChannel : 'unknown',
  };
}

export async function analyzeTravel({ appDir, folder, candidates, docByName, fingerprint, profile = DEFAULT_TRAVEL_PROFILE }) {
  const role = TRAVEL_ROLE_OPTIONS[profile.role] ? profile.role : DEFAULT_TRAVEL_PROFILE.role;
  const fundType = profile.fundType === 'research' ? 'research' : 'budget';
  const entitlement = travelEntitlement(role, fundType);
  const rawFacts = await extractTravelFacts({ appDir, folder, candidates, docByName, fingerprint });
  const facts = normalizeFacts(rawFacts);
  const evidence = travelEvidence(candidates.map(({ name }) => docByName.get(name)).filter(Boolean), facts);
  const warnings = [];
  const blockers = [];

  const allowance = calculateTravelAllowance({
    startDate: facts.startDate,
    endDate: facts.endDate,
    destination: facts.destination || '',
    travelerCount: facts.travelerCount || 1,
    hostCoversMeals: facts.hostCoversMeals === true,
    hostCoversLocalTransport: facts.hostCoversLocalTransport === true,
    noLocalTransportAllowance: facts.noLocalTransportAllowance === true,
    longTermResearch: facts.longTermResearch === true,
  });
  const assumptions = [];
  if (!facts.travelerCount) assumptions.push('未识别人数，暂按 1 人估算');
  if (facts.hostCoversMeals === null) assumptions.push('暂按举办方不承担伙食估算');
  if (facts.hostCoversLocalTransport === null) assumptions.push('暂按承办方不承担期间交通估算');
  if (facts.longTermResearch === null && allowance?.days > 10) assumptions.push('未确认是否属于长时间调研');
  if (!allowance || !facts.destination || !facts.travelerCount) blockers.push('差旅缺少目的地、出发及返程日期或人数，请核对行程材料');

  const lodging = { stays: [], aboveLimitCny: 0, withinLimit: true };
  for (const stay of facts.lodgingStays) {
    const location = stay.location || facts.destination || '';
    const limit = stay.amountCny && stay.guestCount
      ? calculateLodgingLimit({ destination: location, checkInDate: stay.checkInDate, checkOutDate: stay.checkOutDate, travelerCount: stay.guestCount, lodgingGrade: entitlement.lodgingGrade })
      : null;
    if (!stay.amountCny || !limit) {
      lodging.withinLimit = false;
      lodging.stays.push({ ...stay, location, limitCny: null, eligibleCny: null, note: '信息不完整，无法查附表二限额，请人工核对入住地/日期/人数/金额' });
      blockers.push(`住宿（${location || '地点未知'}）信息不完整，无法核对附表二限额`);
      continue;
    }
    if (stay.amountCny > limit.total * 100) {
      const excess = stay.amountCny - Math.round(limit.total * 100);
      lodging.aboveLimitCny += excess;
      lodging.withinLimit = false;
      lodging.stays.push({ ...stay, location, limitCny: Math.round(limit.total * 100), eligibleCny: Math.round(limit.total * 100), note: `${limit.travelerCount} 人 × ${limit.nights} 晚，附表二上限 ${limit.total.toFixed(2)} 元，超出 ${(excess / 100).toFixed(2)} 元自动扣减` });
    } else {
      lodging.stays.push({ ...stay, location, limitCny: Math.round(limit.total * 100), eligibleCny: stay.amountCny, note: `${limit.travelerCount} 人 × ${limit.nights} 晚，附表二上限 ${limit.total.toFixed(2)} 元，未超限` });
    }
  }

  return {
    profile: { role, fundType, roleLabel: entitlement.roleLabel, fundTypeLabel: entitlement.fundTypeLabel, transport: entitlement.transport, lodgingGrade: entitlement.lodgingGrade },
    facts,
    days: allowance?.days ?? null,
    allowance: allowance
      ? { mealAmountCny: Math.round(allowance.mealAmount * 100), localTransportCny: Math.round(allowance.localTransportAmount * 100), totalCny: Math.round(allowance.total * 100), mealRate: allowance.mealRate, localTransportRate: allowance.localTransportRate, note: allowance.note, assumptions }
      : null,
    lodging, evidence,
    warnings, blockers,
  };
}

const sum = (values) => values.reduce((total, value) => total + value, 0);
const money = (cents) => (cents / 100).toFixed(2);

export function reconcileTravel(travel, assessment, byName) {
  const { facts, allowance, lodging, evidence } = travel;
  const blockers = [...travel.blockers];
  const rows = assessment.rows.map((row) => ({ ...row, travelKind: travelInvoiceKind(byName.get(row.invoiceFile)) }));
  const flights = rows.filter(({ travelKind }) => travelKind === 'flight');
  const flightSegments = facts.segments.filter(({ transportMode }) => /飞机|航班|航空/.test(transportMode));
  const flightTotalCny = sum(flights.map(({ paidAmountCny }) => paidAmountCny ?? 0));
  const comparisonTotalCny = sum(evidence.comparisons.map(({ amountCny }) => amountCny));
  const comparisonFiles = evidence.comparisons.map(({ name }) => name);
  const flight = { channel: facts.flightPurchaseChannel, status: 'none', note: '', comparisonFiles };
  if (flights.length) {
    if (!flightSegments.length || flightSegments.some(({ travelDate, serviceNumber }) =>
      !travelDate || travelDate < facts.startDate || travelDate > facts.endDate || !serviceNumber)) blockers.push('机票缺少可核对的出行日期或航班号');
    if (flight.channel === 'third_party' && comparisonFiles.length && flightTotalCny > 0 && comparisonTotalCny > flightTotalCny) {
      flight.status = 'ok';
      flight.note = `实付 ${money(flightTotalCny)} 元，同航班同日公务机票 ${money(comparisonTotalCny)} 元`;
    } else if (flight.channel === 'government' && evidence.inspections.length) {
      flight.status = 'ok';
      flight.note = '已选政府采购机票查验单';
    } else {
      flight.status = 'need_confirm';
      flight.note = flight.channel === 'third_party'
        ? comparisonFiles.length ? '公务机票比价须与机票实付核对，且比价金额须高于实付' : '缺少能匹配实际出行日期和航班号的公务机票比价截图'
        : '请核对机票购买渠道及政府采购机票查验单';
      blockers.push(flight.note);
    }
  }
  const lodgingRows = rows.filter(({ travelKind }) => travelKind === 'lodging');
  const lodgingFace = sum(lodgingRows.map(({ invoiceAmountCny }) => invoiceAmountCny ?? 0));
  if (lodgingFace !== sum(lodging.stays.map(({ amountCny }) => amountCny ?? 0))) blockers.push('住宿发票与入住明细金额无法对应');
  const staysInTrip = lodging.stays.every(({ checkInDate, checkOutDate }) => checkInDate && checkOutDate &&
    checkInDate >= facts.startDate && checkOutDate <= facts.endDate);
  if (!staysInTrip) blockers.push('住宿日期超出本次差旅行程，请核对入住明细');
  const paidLodging = sum(lodgingRows.map(({ reimbursementAmountCny }) => reimbursementAmountCny ?? 0));
  if (lodgingRows.length === 1 && lodging.stays.length && lodgingRows[0].reimbursementAmountCny !== null) {
    lodgingRows[0].reimbursementAmountCny = Math.min(paidLodging, sum(lodging.stays.map(({ eligibleCny }) => eligibleCny ?? 0)));
  } else if (lodgingRows.length > 1) {
    const matched = lodgingRows.map((row) => lodging.stays.filter((stay) => stay.amountCny === row.invoiceAmountCny));
    if (matched.some((stays) => stays.length !== 1) || new Set(matched.map((stays) => stays[0])).size !== lodging.stays.length ||
        matched.length !== lodging.stays.length) {
      blockers.push('多张住宿发票无法逐张对应入住记录，请核对每笔住宿金额');
    } else {
      lodgingRows.forEach((row, index) => {
        if (row.reimbursementAmountCny !== null && matched[index][0].eligibleCny !== null) row.reimbursementAmountCny = Math.min(row.reimbursementAmountCny, matched[index][0].eligibleCny);
      });
    }
  }
  const lodgingCny = sum(lodgingRows.map(({ reimbursementAmountCny }) => reimbursementAmountCny ?? 0));
  const transportCny = sum(rows.filter(({ travelKind }) => travelKind === 'flight' || travelKind === 'rail').map(({ reimbursementAmountCny }) => reimbursementAmountCny ?? 0));
  const otherCny = sum(rows.filter(({ travelKind }) => !travelKind).map(({ reimbursementAmountCny }) => reimbursementAmountCny ?? 0));
  if (!facts.segments.length && !lodgingRows.length) blockers.push('未识别到可核对的国内差旅行程');
  const selectedFiles = new Set([
    ...assessment.uploadNames.filter((name) => !isAirfareComparison(byName.get(name)?.text) &&
      !/^(?:国内)?出差申请(?:单|表)?(?:[-_.（(]|$)/.test(name) &&
      !/^(?:国内)?出差申请(?:单|表)?$/.test(byName.get(name)?.text?.split('\n')[0]?.trim() || '')),
    ...comparisonFiles, ...evidence.itineraries, ...evidence.hotelDetails, ...evidence.inspections,
  ]);
  const amounts = allowance && assessment.totalCny !== null ? {
    transportCny, lodgingCny, otherCny, mealCny: allowance.mealAmountCny, localTransportCny: allowance.localTransportCny,
    ticketCny: sum(rows.map(({ reimbursementAmountCny }) => reimbursementAmountCny ?? 0)),
  } : null;
  return {
    travel: { ...travel, flight, lodging: { ...lodging, deductionCny: paidLodging - lodgingCny }, blockers, amounts },
    rows, uploadNames: [...selectedFiles],
    totalCny: amounts ? amounts.ticketCny + amounts.mealCny + amounts.localTransportCny : null,
  };
}

export function validTravelAmounts(plan) {
  const amounts = plan.travel?.amounts;
  const allowance = plan.travel?.allowance;
  if (!amounts || !allowance || plan.claimType !== '国内差旅' || plan.reimbursementRoute !== 'smart') return false;
  const keys = ['transportCny', 'lodgingCny', 'otherCny', 'mealCny', 'localTransportCny', 'ticketCny'];
  if (keys.some((key) => !Number.isSafeInteger(amounts[key]) || amounts[key] < 0)) return false;
  const rows = plan.rows;
  const lodgingMax = sum((plan.travel.lodging?.stays || []).map(({ eligibleCny }) => eligibleCny ?? 0));
  return amounts.mealCny === allowance.mealAmountCny && amounts.localTransportCny === allowance.localTransportCny &&
    amounts.lodgingCny <= lodgingMax &&
    amounts.lodgingCny === sum(rows.filter(({ travelKind }) => travelKind === 'lodging').map(({ reimbursementAmountCny }) => reimbursementAmountCny)) &&
    amounts.transportCny === sum(rows.filter(({ travelKind }) => travelKind === 'flight' || travelKind === 'rail').map(({ reimbursementAmountCny }) => reimbursementAmountCny)) &&
    amounts.ticketCny === amounts.transportCny + amounts.lodgingCny + amounts.otherCny &&
    plan.ticketTotalCny === amounts.ticketCny && amounts.ticketCny === sum(rows.map((row) => row.reimbursementAmountCny)) &&
    plan.totalCny === amounts.ticketCny + amounts.mealCny + amounts.localTransportCny;
}
