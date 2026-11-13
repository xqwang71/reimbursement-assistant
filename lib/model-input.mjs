export function redactModelText(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[网址]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱]')
    .replace(/(?<!\d)(?:\d[ -]?){17}[\dXx](?!\d)/g, '[长编号]')
    .replace(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, '[长编号]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号]')
    .replace(/((?:姓名|证件号码?|身份证号码?|银行账号|银行账户|银行卡号|银行尾号|尾号|手机号|手机号码|开户行|收款人|付款人|持卡人|旅客|乘车人|出差人(?:员)?)\s*[:：]?\s*)[^\r\n，,；;。|]{1,100}/g, '$1[已隐藏]');
}
