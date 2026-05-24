/**
 * Salary Parsers
 * Shared helpers to parse salary minimum, maximum, currency, and average
 * from job title and description.
 */

/**
 * Parses salary requirements from title and description.
 * Normalizes values into integer salary_min, salary_max, ISO currency, and average.
 * 
 * @param {string} title - The job title
 * @param {string} description - The job description
 * @returns {object} - { salary_min: integer|null, salary_max: integer|null, salary_currency: string|null, salary_avg: integer|null }
 */
export function parseSalary(title, description) {
  const titleText = (title || '').toLowerCase();
  const descText = (description || '').toLowerCase();
  const text = `${titleText} ${descText}`;

  let currency = null;

  // 1. Detect Currency from symbols and keywords
  if (text.includes('₹') || text.includes('inr') || text.includes('lpa') || text.includes('lakh')) {
    currency = 'INR';
  } else if (text.includes('$') || text.includes('usd')) {
    currency = 'USD';
  } else if (text.includes('£') || text.includes('gbp') || text.includes('p/a')) {
    currency = 'GBP';
  } else if (text.includes('€') || text.includes('eur')) {
    currency = 'EUR';
  }

  // Helper to parse numerical strings (e.g. "45k" -> 45000, "15 LPA" -> 1500000)
  function parseVal(valStr, isLpa) {
    let val = valStr.replace(/,/g, '').trim();
    if (val.endsWith('k')) {
      return parseFloat(val) * 1000;
    }
    if (isLpa) {
      return parseFloat(val) * 100000; // 1 Lakh = 100,000 INR
    }
    return parseFloat(val);
  }

  // Helper to construct response and calculate average
  function makeResult(minVal, maxVal, detectedCurrency) {
    const min = Math.round(minVal);
    const max = Math.round(maxVal);
    const avg = Math.round((min + max) / 2);
    return {
      salary_min: min,
      salary_max: max,
      salary_currency: detectedCurrency || 'USD',
      salary_avg: avg
    };
  }

  // 2. Look for Indian LPA format first (e.g., "10-15 LPA", "10 to 15 lakhs", "12 LPA")
  const lpaRegexes = [
    /\b(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(?:lpa|lakhs?)\b/,
    /\b(\d+(?:\.\d+)?)\s*(?:lpa|lakhs?)\b/
  ];

  for (const regex of lpaRegexes) {
    const match = text.match(regex);
    if (match) {
      const minVal = parseVal(match[1], true);
      const maxVal = match[2] ? parseVal(match[2], true) : minVal;
      return makeResult(minVal, maxVal, 'INR');
    }
  }

  // 3. Look for standard currency-range format (e.g., "$120,000 - $150,000", "£38,488 - 46,852", "€80k - €100k")
  const rangeRegexes = [
    /(?:[$£€₹])\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?k?)\s*(?:-|to)\s*(?:[$£€₹])?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?k?)\b/,
    /\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?k?)\s*(?:-|to)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?k?)\s*(?:per\s+year|per\s+annum|p\.?a\.?|annually)\b/
  ];

  for (const regex of rangeRegexes) {
    const match = text.match(regex);
    if (match) {
      const minVal = parseVal(match[1], false);
      const maxVal = parseVal(match[2], false);

      // Skip small hourly/daily rates (e.g., 40-60)
      if (minVal < 500) continue;

      return makeResult(minVal, maxVal, currency);
    }
  }

  // 4. Look for single annual salary with keyword
  const singleRegex = /\bsalary\b.{0,50}?(?:[$£€₹])?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?k?)\b/;
  const match = text.match(singleRegex);
  if (match) {
    const minVal = parseVal(match[1], false);
    if (minVal >= 500) {
      return makeResult(minVal, minVal, currency);
    }
  }

  return {
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_avg: null
  };
}
