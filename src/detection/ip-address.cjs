// Shared by browser probes and the Node gateway; excludes non-global special-use addresses.
/** @param {string} ip */
function isPublicIp(ip) {
  if (ip.includes(':')) {
    if (!/^[\da-f:.]+$/i.test(ip)) return false;
    try {
      const address = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
      return !/^(::|f[cd]|fe[89ab]|ff|64:ff9b:1(?::|$)|100:(?::|0:0:1:)|2001:(?:db8(?::|$)|2:(?::|0(?::|$)))|3fff:(?::|[0-9a-f]{1,3}:)|5f00:)/i.test(address);
    } catch { return false; }
  }
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(ip)) return false;
  const [a, b, c, d] = ip.split('.').map(Number);
  if ([a, b, c, d].some((part) => part > 255)) return false;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 2 || c === 0 && d !== 9 && d !== 10)) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113));
}
exports.isPublicIp = isPublicIp;
