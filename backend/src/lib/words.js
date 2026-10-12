// An amount in words the Indian way (lakh and crore), as printed on purchase orders and invoices:
// 1,23,456.50 reads "One Lakh Twenty Three Thousand Four Hundred and Fifty Six Rupees and Fifty Paise Only".

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

const below100 = n => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`)

function below1000(n) {
  const h = Math.floor(n / 100), r = n % 100
  return [h ? `${ONES[h]} Hundred` : '', r ? `${h ? 'and ' : ''}${below100(r)}` : ''].filter(Boolean).join(' ')
}

/** A whole number in Indian words: crore, lakh, thousand, hundred. Zero is "Zero". */
export function integerInWords(n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('integerInWords needs a whole number, zero or more')
  if (n === 0) return 'Zero'
  const parts = []
  const crore = Math.floor(n / 10000000), lakh = Math.floor((n % 10000000) / 100000)
  const thousand = Math.floor((n % 100000) / 1000), rest = n % 1000
  if (crore) parts.push(`${integerInWords(crore)} Crore`)
  if (lakh) parts.push(`${below100(lakh)} Lakh`)
  if (thousand) parts.push(`${below100(thousand)} Thousand`)
  if (rest) parts.push(below1000(rest))
  return parts.join(' ')
}

/** "Rupees ... Only" for an amount in rupees (two decimal places of paise). */
export function amountInWords(amount) {
  const paise = Math.round(Math.abs(Number(amount) || 0) * 100)
  const rupees = Math.floor(paise / 100), p = paise % 100
  const r = `${integerInWords(rupees)} Rupees`
  return `${r}${p ? ` and ${below100(p)} Paise` : ''} Only`
}
