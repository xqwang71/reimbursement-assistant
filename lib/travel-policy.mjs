export const TRAVEL_ROLE_OPTIONS = Object.freeze({
  ministerial_academician: {
    label: '部级及相当职务人员、院士',
    lodgingGrade: '部级',
    budgetTransport: '高铁/动车商务座、轮船一等舱、飞机头等舱',
    researchTransport: '高铁/动车商务座、轮船一等舱、飞机头等舱',
  },
  senior_50_plus: {
    label: '50 周岁及以上正高级专业技术职务人员',
    lodgingGrade: '司局级',
    budgetTransport: '高铁/动车一等座、轮船二等舱、飞机经济舱',
    researchTransport: '火车和轮船按本人职务职称档次，飞机可乘公务舱',
  },
  bureau_senior: {
    label: '局级、教授、研究员及办法列明的五级以上副高等人员',
    lodgingGrade: '司局级',
    budgetTransport: '高铁/动车一等座、轮船二等舱、飞机经济舱',
    researchTransport: '高铁/动车一等座、轮船二等舱、飞机经济舱',
  },
  other: {
    label: '其他人员（含学生）',
    lodgingGrade: '其他人员',
    budgetTransport: '高铁/动车二等座、轮船三等舱、飞机经济舱',
    researchTransport: '高铁/动车二等座、轮船三等舱、飞机经济舱',
  },
});

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function inclusiveTravelDays(startDate, endDate) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (start === null || end === null || end < start) return null;
  return Math.floor((end - start) / 86_400_000) + 1;
}

function allowanceDayUnits(days, longTermResearch) {
  if (!longTermResearch || days <= 10) return days;
  return 10 + (days - 10) * 0.5;
}

export function calculateTravelAllowance({
  startDate,
  endDate,
  destination = '',
  travelerCount = 1,
  hostCoversMeals = false,
  hostCoversLocalTransport = false,
  noLocalTransportAllowance = false,
  longTermResearch = false,
} = {}) {
  const days = inclusiveTravelDays(startDate, endDate);
  if (!days) return null;
  const people = Number.isInteger(travelerCount) && travelerCount > 0 ? travelerCount : 1;
  const mealRate = /西藏|青海|新疆/.test(destination) ? 120 : 100;
  const transitDays = Math.min(days, 2);
  const mealUnits = hostCoversMeals ? transitDays : allowanceDayUnits(days, longTermResearch);
  const transportUnits = noLocalTransportAllowance ? 0 : hostCoversLocalTransport ? transitDays : allowanceDayUnits(days, longTermResearch);
  const mealAmount = mealUnits * mealRate * people;
  const localTransportAmount = transportUnits * 80 * people;
  return {
    days,
    travelerCount: people,
    mealRate,
    localTransportRate: 80,
    mealAmount,
    localTransportAmount,
    total: mealAmount + localTransportAmount,
    note: `按 ${people} 人、${days} 个自然日估算：伙食 ${mealAmount.toFixed(2)} 元，市内交通 ${localTransportAmount.toFixed(2)} 元。`,
  };
}

export function calculateTravelReimbursementEstimate({ invoiceTotal, allowanceTotal, lodgingAmountAboveLimit = 0 } = {}) {
  if (![invoiceTotal, allowanceTotal, lodgingAmountAboveLimit].every(Number.isFinite)) return null;
  return Math.max(0, invoiceTotal + allowanceTotal - lodgingAmountAboveLimit);
}

export function travelEntitlement(role, fundType = 'budget') {
  const selected = TRAVEL_ROLE_OPTIONS[role];
  if (!selected) return null;
  return {
    roleLabel: selected.label,
    lodgingGrade: selected.lodgingGrade,
    transport: fundType === 'research' ? selected.researchTransport : selected.budgetTransport,
    fundTypeLabel: fundType === 'research' ? '科研类经费' : '预算类经费',
  };
}

const lodgingRules = [
  { region: /北京/, areas: [{ rates: [1100, 650, 500] }] },
  { region: /大连/, areas: [{ rates: [800, 490, 350], seasonal: [{ months: [7, 8, 9], rates: [960, 590, 420] }] }] },
  { region: /宁波/, areas: [{ rates: [800, 450, 350] }] },
  { region: /厦门/, areas: [{ rates: [900, 500, 400] }] },
  { region: /青岛/, areas: [{ rates: [800, 490, 380], seasonal: [{ months: [7, 8, 9], rates: [960, 590, 450] }] }] },
  { region: /深圳/, areas: [{ rates: [900, 550, 450] }] },
  { region: /天津/, areas: [{ match: /宁河/, rates: [600, 350, 320] }, { rates: [800, 480, 380] }] },
  { region: /河北|石家庄|张家口|秦皇岛|廊坊|承德|保定/, areas: [
    { match: /张家口/, rates: [800, 450, 350], seasonal: [{ months: [7, 8, 9, 11, 12, 1, 2, 3], rates: [1200, 675, 525] }] },
    { match: /秦皇岛/, rates: [800, 450, 350], seasonal: [{ months: [7, 8], rates: [1200, 680, 500] }] },
    { match: /承德/, rates: [800, 450, 350], seasonal: [{ months: [7, 8, 9], rates: [1000, 580, 580] }] },
    { match: /石家庄|廊坊|保定/, rates: [800, 450, 350] }, { rates: [800, 450, 310] },
  ] },
  { region: /山西|太原|大同|晋城|临汾|阳泉|长治|晋中/, areas: [{ match: /太原|大同|晋城/, rates: [800, 480, 350] }, { match: /临汾/, rates: [800, 480, 330] }, { match: /阳泉|长治|晋中/, rates: [800, 480, 310] }, { rates: [800, 400, 240] }] },
  { region: /内蒙古|呼和浩特|海拉尔|满洲里|阿尔山|二连浩特|额济纳/, areas: [
    { match: /呼和浩特/, rates: [800, 460, 350] },
    { match: /海拉尔|满洲里|阿尔山/, rates: [800, 460, 320], seasonal: [{ months: [7, 8, 9], rates: [1200, 690, 480] }] },
    { match: /二连浩特/, rates: [800, 460, 320], seasonal: [{ months: [7, 8, 9], rates: [1000, 580, 400] }] },
    { match: /额济纳/, rates: [800, 460, 320], seasonal: [{ months: [9, 10], rates: [1200, 690, 480] }] }, { rates: [800, 460, 320] },
  ] },
  { region: /辽宁|沈阳/, areas: [{ match: /沈阳/, rates: [800, 480, 350] }, { rates: [800, 480, 330] }] },
  { region: /吉林|长春|延边|长白山/, areas: [{ match: /长春/, rates: [800, 450, 350] }, { match: /吉林市|延边|长白山/, rates: [800, 450, 350], seasonal: [{ months: [7, 8, 9], rates: [960, 540, 420] }] }, { rates: [750, 400, 300] }] },
  { region: /黑龙江|哈尔滨|牡丹江|伊春|大兴安岭|黑河|佳木斯/, areas: [{ match: /哈尔滨/, rates: [800, 450, 350], seasonal: [{ months: [7, 8, 9], rates: [960, 540, 420] }] }, { match: /牡丹江|伊春|大兴安岭|黑河|佳木斯/, rates: [750, 450, 300], seasonal: [{ months: [6, 7, 8], rates: [900, 540, 360] }] }, { rates: [750, 450, 300] }] },
  { region: /上海/, areas: [{ rates: [1100, 600, 500] }] },
  { region: /江苏|南京|苏州|无锡|常州|镇江/, areas: [{ match: /南京|苏州|无锡|常州|镇江/, rates: [900, 490, 380] }, { rates: [900, 490, 360] }] },
  { region: /浙江|杭州/, areas: [{ match: /杭州/, rates: [900, 500, 400] }, { rates: [800, 490, 340] }] },
  { region: /安徽/, areas: [{ rates: [800, 460, 350] }] },
  { region: /福建|福州|泉州|平潭/, areas: [{ match: /福州|泉州|平潭/, rates: [900, 480, 380] }, { rates: [900, 480, 350] }] },
  { region: /江西/, areas: [{ rates: [800, 470, 350] }] },
  { region: /山东|济南|淄博|枣庄|东营|烟台|潍坊|济宁|泰安|威海|日照/, areas: [{ match: /烟台|威海|日照/, rates: [800, 480, 380], seasonal: [{ months: [7, 8, 9], rates: [960, 570, 450] }] }, { match: /济南|淄博|枣庄|东营|潍坊|济宁|泰安/, rates: [800, 480, 380] }, { rates: [800, 460, 360] }] },
  { region: /河南|郑州|洛阳/, areas: [{ match: /郑州/, rates: [900, 480, 380] }, { match: /洛阳/, rates: [800, 480, 330], seasonal: [{ months: [4], rates: [1200, 720, 500] }, { months: [5], throughDay: 10, rates: [1200, 720, 500] }] }, { rates: [800, 480, 330] }] },
  { region: /湖北|武汉/, areas: [{ match: /武汉/, rates: [800, 480, 350] }, { rates: [800, 480, 320] }] },
  { region: /湖南|长沙/, areas: [{ match: /长沙/, rates: [800, 450, 350] }, { rates: [800, 450, 330] }] },
  { region: /广东|广州|珠海|佛山|东莞|中山|江门/, areas: [{ match: /广州|珠海|佛山|东莞|中山|江门/, rates: [900, 550, 450] }, { rates: [850, 530, 420] }] },
  { region: /广西|南宁|桂林|北海/, areas: [{ match: /南宁/, rates: [800, 470, 350] }, { match: /桂林|北海/, rates: [800, 470, 330], seasonal: [{ months: [1, 2, 7, 8, 9], rates: [1040, 610, 430] }] }, { rates: [800, 470, 330] }] },
  { region: /海南省|海口|三亚|三沙|儋州|五指山|文昌|琼海|万宁|东方|定安|屯昌|澄迈|临高|白沙|昌江|乐东|陵水|保亭|琼中|洋浦/, areas: [
    { match: /三亚/, rates: [1000, 600, 400], seasonal: [{ months: [10, 11, 12, 1, 2, 3, 4], rates: [1200, 720, 480] }] },
    { match: /海口|文昌|澄迈/, rates: [800, 500, 350], seasonal: [{ months: [11, 12, 1, 2], rates: [1040, 650, 450] }] },
    { match: /琼海|万宁|陵水|保亭/, rates: [800, 500, 350], seasonal: [{ months: [11, 12, 1, 2, 3], rates: [1040, 650, 450] }] }, { rates: [800, 500, 350] },
  ] },
  { region: /重庆/, areas: [{ match: /中心城区|北部新区/, rates: [800, 480, 370] }, { rates: [770, 450, 300] }] },
  { region: /四川|成都|阿坝|甘孜|绵阳|乐山|雅安|宜宾|凉山|德阳|遂宁|巴中/, areas: [{ match: /成都/, rates: [900, 470, 370] }, { match: /阿坝|甘孜/, rates: [800, 430, 330] }, { match: /绵阳|乐山|雅安/, rates: [800, 430, 320] }, { match: /宜宾/, rates: [800, 430, 300] }, { match: /凉山/, rates: [750, 430, 330] }, { match: /德阳|遂宁|巴中/, rates: [750, 430, 310] }, { rates: [750, 430, 300] }] },
  { region: /贵州|贵阳/, areas: [{ match: /贵阳/, rates: [800, 470, 370] }, { rates: [750, 450, 300] }] },
  { region: /云南|昆明|大理|丽江|迪庆|西双版纳/, areas: [{ match: /昆明|大理|丽江|迪庆|西双版纳/, rates: [900, 480, 380] }, { rates: [900, 480, 330] }] },
  { region: /西藏|拉萨/, areas: [{ match: /拉萨/, rates: [800, 500, 350], seasonal: [{ months: [6, 7, 8, 9], rates: [1200, 750, 530] }] }, { rates: [500, 400, 300], seasonal: [{ months: [6, 7, 8, 9], rates: [800, 500, 350] }] }] },
  { region: /陕西|西安|榆林|延安|杨凌|咸阳|宝鸡|渭南|韩城/, areas: [{ match: /西安/, rates: [800, 460, 350] }, { match: /榆林|延安/, rates: [680, 350, 300] }, { match: /杨凌/, rates: [680, 320, 260] }, { match: /咸阳|宝鸡/, rates: [600, 320, 260] }, { match: /渭南|韩城/, rates: [600, 300, 260] }, { rates: [600, 300, 230] }] },
  { region: /甘肃|兰州/, areas: [{ match: /兰州/, rates: [800, 470, 350] }, { rates: [700, 450, 310] }] },
  { region: /青海|西宁|玉树|果洛|海北|黄南|海东|海南州|海西/, areas: [{ match: /西宁/, rates: [800, 500, 350], seasonal: [{ months: [6, 7, 8, 9], rates: [1200, 750, 530] }] }, { match: /玉树/, rates: [600, 350, 300], seasonal: [{ months: [5, 6, 7, 8, 9], rates: [900, 525, 450] }] }, { match: /果洛/, rates: [600, 350, 300] }, { match: /海北|黄南/, rates: [600, 350, 250], seasonal: [{ months: [5, 6, 7, 8, 9], rates: [900, 525, 375] }] }, { match: /海东|海南州/, rates: [600, 300, 250], seasonal: [{ months: [5, 6, 7, 8, 9], rates: [900, 450, 375] }] }, { match: /海西/, rates: [600, 300, 200], seasonal: [{ months: [5, 6, 7, 8, 9], rates: [900, 450, 300] }] }] },
  { region: /宁夏|银川/, areas: [{ match: /银川/, rates: [800, 470, 350] }, { rates: [800, 430, 330] }] },
  { region: /新疆|乌鲁木齐|石河子|克拉玛依|昌吉|伊犁|阿勒泰|博州|吐鲁番|哈密|巴州|和田|克州|喀什|阿克苏|塔城/, areas: [{ match: /乌鲁木齐/, rates: [800, 480, 350] }, { match: /石河子|克拉玛依|昌吉|伊犁|阿勒泰|博州|吐鲁番|哈密|巴州|和田/, rates: [800, 480, 340] }, { match: /克州/, rates: [800, 480, 320] }, { match: /喀什/, rates: [780, 480, 300] }, { match: /阿克苏/, rates: [700, 450, 300] }, { match: /塔城/, rates: [700, 400, 300] }] },
];

const lodgingGradeIndex = { '部级': 0, '司局级': 1, '其他人员': 2 };

export function lodgingRateForDate(destination, dateValue, lodgingGrade) {
  const date = new Date(`${dateValue}T00:00:00Z`);
  if (!destination || Number.isNaN(date.getTime()) || !(lodgingGrade in lodgingGradeIndex)) return null;
  const rule = lodgingRules.find((item) => item.region.test(destination));
  if (!rule) return null;
  const area = rule.areas.find((item) => !item.match || item.match.test(destination));
  if (!area) return null;
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const seasonal = area.seasonal?.find((item) => item.months.includes(month) && (!item.throughDay || day <= item.throughDay));
  return (seasonal?.rates || area.rates)[lodgingGradeIndex[lodgingGrade]];
}

export function calculateLodgingLimit({ destination, checkInDate, checkOutDate, travelerCount = 1, lodgingGrade } = {}) {
  const start = parseIsoDate(checkInDate);
  const end = parseIsoDate(checkOutDate);
  if (start === null || end === null || end <= start) return null;
  const people = Number.isInteger(travelerCount) && travelerCount > 0 ? travelerCount : 1;
  let total = 0;
  const dailyRates = [];
  for (let cursor = start; cursor < end; cursor += 86_400_000) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    const rate = lodgingRateForDate(destination, date, lodgingGrade);
    if (!Number.isFinite(rate)) return null;
    dailyRates.push({ date, rate });
    total += rate * people;
  }
  return { nights: dailyRates.length, travelerCount: people, dailyRates, total };
}
