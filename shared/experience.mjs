/**
 * Experience Parsers
 * Shared helpers to parse years of experience and infer experience level
 * from job title and description.
 */

/**
 * Parses years of experience requirement from title and description.
 * Standardizes to formats like "X-Y years", "X+ years", or "0-1 years".
 * Ignores matches that are part of age limit requirements (e.g. "Age Limit: 21-30 years" or "20-28 years age group").
 * 
 * @param {string} title - The job title
 * @param {string} description - The job description
 * @returns {string|null} - Standardized experience string or null
 */
export function parseExperience(title, description) {
  const titleText = (title || '').toLowerCase();
  const descText = (description || '').toLowerCase();

  // Helper to extract first match and return normalized string
  function extract(text) {
    function isAge(index, matchStr) {
      // Extract up to 45 characters preceding the match
      const beforeContext = text.slice(Math.max(0, index - 45), index);
      // Extract up to 45 characters following the match
      const afterContext = text.slice(index + matchStr.length, Math.min(text.length, index + matchStr.length + 45));
      const combined = beforeContext + ' | ' + afterContext;
      // Check if context mentions age keywords using word boundaries to prevent matches on "management"
      return /\b(?:age|aged|ages|born|dob|birth)\b/.test(combined);
    }

    // 1. Check for specific ranges: "X-Y years" or "X to Y years" or "X-Y yrs"
    const rangeRegex = /\b(\d+)\s*(?:-|to)\s*(\d+)\s*(?:years?|yrs?)\b/g;
    let match;
    while ((match = rangeRegex.exec(text)) !== null) {
      if (!isAge(match.index, match[0])) {
        return `${match[1]}-${match[2]} years`;
      }
    }

    // 2. Check for X+ years: "X+ years", "X+ yrs", "X years+", "X yrs+"
    const plusRegex1 = /\b(\d+)\s*\+\s*(?:years?|yrs?)\b/g;
    while ((match = plusRegex1.exec(text)) !== null) {
      if (!isAge(match.index, match[0])) {
        return `${match[1]}+ years`;
      }
    }
    const plusRegex2 = /\b(\d+)\s*(?:years?|yrs?)\s*\+/g;
    while ((match = plusRegex2.exec(text)) !== null) {
      if (!isAge(match.index, match[0])) {
        return `${match[1]}+ years`;
      }
    }

    // 3. Check for single years with keywords (minimum, required, at least, etc.)
    const keywordRegex = /\b(?:min|minimum|at least|req|require|requires|required|over|more than)[^a-z0-9]*(\d+)\s*(?:years?|yrs?)\b/g;
    while ((match = keywordRegex.exec(text)) !== null) {
      if (!isAge(match.index, match[0])) {
        return `${match[1]}+ years`;
      }
    }

    const expRegex1 = /\b(\d+)\s*(?:years?|yrs?)\b[^a-z0-9]*(?:of\s+)?(?:\w+\s+){0,3}experience\b/g;
    while ((match = expRegex1.exec(text)) !== null) {
      if (!isAge(match.index, match[0])) {
        return `${match[1]}+ years`;
      }
    }

    const expRegex2 = /\b(\d+)\s*(?:years?|yrs?)\b[^a-z0-9]*(?:of\s+)?(?:\w+\s+){0,3}exp\b/g;
    while ((match = expRegex2.exec(text)) !== null) {
      if (!isAge(match.index, match[0])) {
        return `${match[1]}+ years`;
      }
    }

    // 4. Check for fresher/0-1 years signals using word boundaries
    if (
      /\bfresher\b/.test(text) ||
      /\bno experience\b/.test(text) ||
      /\b0\s*years?\b/.test(text) ||
      /\b0\s*-\s*1\s*years?\b/.test(text) ||
      /\b0\s*to\s*1\s*years?\b/.test(text)
    ) {
      return '0-1 years';
    }

    return null;
  }

  // Check title first as it's more specific and less noisy
  const titleResult = extract(titleText);
  if (titleResult) return titleResult;

  // Fallback to description
  const descResult = extract(descText);
  if (descResult) return descResult;

  return null;
}

/**
 * Infers the experience level (entry, mid, senior, executive) from title and description.
 * Uses parsed years of experience as a supplementary signal.
 * 
 * @param {string} title - The job title
 * @param {string} description - The job description
 * @param {string|null} parsedYears - Standardized experience string (from parseExperience)
 * @returns {string|null} - "entry" | "mid" | "senior" | "executive" | null
 */
export function inferExperienceLevel(title, description, parsedYears) {
  const titleLower = (title || '').toLowerCase();
  const text = ((title || '') + ' ' + (description || '')).toLowerCase();

  // 1. Executive signals in title
  if (
    titleLower.includes('vp ') ||
    titleLower.includes('vice president') ||
    titleLower.includes('director') ||
    titleLower.includes('chief') ||
    titleLower.includes('head of')
  ) {
    return 'executive';
  }

  // 2. Senior signals in title
  if (
    titleLower.includes('senior') ||
    titleLower.includes('sr.') ||
    titleLower.includes('sr ') ||
    titleLower.includes('staff') ||
    titleLower.includes('principal') ||
    titleLower.includes('lead ')
  ) {
    return 'senior';
  }

  // 3. Entry/Intern signals in title
  if (
    titleLower.includes('junior') ||
    titleLower.includes('jr.') ||
    titleLower.includes('jr ') ||
    titleLower.includes('entry') ||
    titleLower.includes('associate') ||
    titleLower.includes('intern') ||
    titleLower.includes('fresher') ||
    titleLower.includes('trainee')
  ) {
    return 'entry';
  }

  // 4. Mid/Manager signals in title
  if (
    titleLower.includes('manager') ||
    titleLower.includes('mid-level') ||
    titleLower.includes('mid level')
  ) {
    return 'mid';
  }

  // 5. Fallback to parsing years of experience if available
  if (parsedYears) {
    const numbers = parsedYears.match(/\d+/g);
    if (numbers && numbers.length > 0) {
      const minYears = parseInt(numbers[0], 10);
      if (minYears >= 8) return 'executive';
      if (minYears >= 5) return 'senior';
      if (minYears >= 2) return 'mid';
      if (minYears >= 0) return 'entry';
    }
  }

  // 6. Text body checks as fallback
  if (
    text.includes('vp ') ||
    text.includes('vice president') ||
    text.includes('director') ||
    text.includes('chief')
  ) {
    return 'executive';
  }
  if (
    text.includes('senior') ||
    text.includes('staff ') ||
    text.includes('principal') ||
    text.includes('lead ')
  ) {
    return 'senior';
  }
  if (
    text.includes('junior') ||
    text.includes('entry') ||
    text.includes('associate') ||
    text.includes('intern') ||
    text.includes('fresher')
  ) {
    return 'entry';
  }
  if (
    text.includes('manager') ||
    text.includes('mid-level') ||
    text.includes('mid level')
  ) {
    return 'mid';
  }

  return null;
}
