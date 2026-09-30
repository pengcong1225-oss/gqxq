export function hasImmediateComplaintPredicate(text: string): boolean {
  return /^(?:投诉|举报|反映|咨询|告知|要求|请求|催促|建议|希望)/.test(text);
}

export function isRejectedLocationContext(text: string, start: number): boolean {
  const preceding = text.slice(Math.max(0, start - 20), start).replace(/[\s，,。；;：:、.!?！？]/g, '');
  return /(?:不是|并非|不在|非|没有|无关|不属于|以前|过去|原来|曾经|之前|旧址|转交到|搬离|离开)(?:[\u4e00-\u9fff]{0,5})$/.test(preceding);
}
