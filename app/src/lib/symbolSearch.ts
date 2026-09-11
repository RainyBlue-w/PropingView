import type { SymbolInfo } from '../types/market';

const MONTH_CODES = 'FGHJKMNQUVXZ';
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

interface ContractCode { root: string; month: number; year: string }

/** Only recognize explicit contract codes, never dates inside a product description. */
function parseContract(code: string): ContractCode | null {
  const numeric = /^([A-Z0-9]+?)\s*(0[1-9]|1[0-2])-(\d{4}|\d{2})$/.exec(code);
  if (numeric && /[A-Z]/.test(numeric[1])) return { root: numeric[1], month: Number(numeric[2]), year: numeric[3] };
  const named = /^([A-Z0-9]+)\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*(\d{4}|\d{2})$/.exec(code);
  if (named && /[A-Z]/.test(named[1])) return { root: named[1], month: MONTH_NAMES.indexOf(named[2]) + 1, year: named[3] };
  const compact = /^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{4}|\d{2}|\d)$/.exec(code);
  if (compact && /[A-Z]/.test(compact[1])) return { root: compact[1], month: MONTH_CODES.indexOf(compact[2]) + 1, year: compact[3] };
  return null;
}

function contractFor(symbol: SymbolInfo): ContractCode | null {
  if (symbol.type?.toLowerCase() !== 'futures') return null;
  // ATAS exchange/disambiguation suffixes stay on the returned native symbol.
  const parsed = parseContract(symbol.symbol.toUpperCase().split(/[@#]/, 1)[0].trim());
  if (!parsed) return null;
  const years = [...new Set(symbol.name.match(/\b(?:19|20|21)\d{2}\b/g) || [])];
  if (years.length === 1 && years[0].endsWith(parsed.year)) return { ...parsed, year: years[0] };
  // U6 alone cannot establish whether this is 2026 or 2036.
  return parsed.year.length > 1 ? parsed : null;
}

function sameContract(actual: ContractCode, query: ContractCode): boolean {
  return actual.root === query.root && actual.month === query.month
    && actual.year.length >= query.year.length && actual.year.endsWith(query.year);
}

/** Search aliases are display-only: every result retains its original object and native symbol. */
export function filterSymbols(symbols: SymbolInfo[], query: string): SymbolInfo[] {
  const text = query.trim().toUpperCase();
  if (!text) return [...symbols];
  const requested = parseContract(text);
  return symbols.map((symbol, index) => {
    const code = symbol.symbol.toUpperCase();
    const name = symbol.name.toUpperCase();
    const baseCode = code.split(/[@#]/, 1)[0].trim();
    let score = Infinity;
    if (code === text) score = 0;
    else if (baseCode === text) score = 1;
    else {
      const contract = contractFor(symbol);
      if (requested && contract) {
        // An explicit NQ expiry must not also match MNQ or a different month/year.
        if (sameContract(contract, requested)) score = 2;
      } else if (requested && symbol.type?.toLowerCase() === 'futures' && parseContract(baseCode)) {
        // Keep literal native searches for incomplete U6 data; do not invent longer years.
        if (name === text) score = 3;
      } else if (code.startsWith(text)) score = 2;
      else if (name.startsWith(text)) score = 3;
      else if (code.includes(text)) score = 4;
      else if (name.includes(text)) score = 5;
    }
    return { symbol, index, score };
  }).filter(row => Number.isFinite(row.score))
    .sort((a, b) => a.score - b.score || a.index - b.index).map(row => row.symbol);
}
