// "₱70,984.50", "₱55,121", "-₱1,250.50": whole amounts without decimals,
// amounts with centavos always with two digits (never "₱70,984.5").
export function formatPeso(value) {
  const amount = Number(value) || 0
  const hasCentavos = Math.round(Math.abs(amount) * 100) % 100 !== 0
  const text = Math.abs(amount).toLocaleString('en-PH', {
    minimumFractionDigits: hasCentavos ? 2 : 0,
    maximumFractionDigits: 2,
  })
  return `${amount < 0 ? '-' : ''}₱${text}`
}
