/**
 * Heuristic classification of regulatory items.
 *
 * These are keyword rules over the authority's own headline and summary, not a
 * regulatory determination. The UI labels every value as auto-classified so a
 * reader never mistakes it for the authority's official categorisation, and
 * every card links back to the primary source.
 */

export const CATEGORIES = [
  'Recall',
  'Safety Alert',
  'Approval',
  'Guidance',
  'Enforcement',
  'Shortage',
  'Inspection',
  'Outbreak',
  'Policy',
  'Other',
];

export const SEVERITIES = ['critical', 'high', 'medium', 'info'];

// Ordered: the first rule that matches wins, so more specific and more urgent
// categories are listed before general ones.
const CATEGORY_RULES = [
  ['Recall', /\b(recall|recalled|recalling|withdraw(al|n)? from the market|market withdrawal|rappel|retirada|rückruf)\b/i],
  ['Shortage', /\b(shortage|supply disruption|discontinuation|out of stock|desabastecimiento|lieferengpass)\b/i],
  ['Outbreak', /\b(outbreak|epidemic|pandemic|disease outbreak news|cases of)\b/i],
  ['Safety Alert', /\b(safety (alert|advisory|communication|update|information)|drug safety|adverse (event|reaction)|contraindicat|warning letter to patients|falsified|substandard|counterfeit|do not use|risk of)\b/i],
  ['Enforcement', /\b(warning letter|enforcement|injunction|seizure|import alert|prosecut|penalt|sanction|fine[ds]?\b|illegal)\b/i],
  ['Inspection', /\b(inspection|gmp|gdp|good manufacturing practice|audit|non-?compliance report|manufacturing site)\b/i],
  ['Approval', /\b(approv|authoris|authoriz|clearance|510\(k\)|marketing authorisation|licens(ed|ing)|designation|indication extension|first generic|de novo)\b/i],
  ['Guidance', /\b(guidance|guideline|draft (document|guidance)|consultation|q&a|questions and answers|standard|monograph|template)\b/i],
  ['Policy', /\b(regulation|directive|legislation|policy|framework|strategy|rule\b|act\b|amendment|fee schedule)\b/i],
];

const CRITICAL_PATTERNS = [
  /\bclass\s*i\b(?!\s*i)/i,              // Class I recall (not Class II/III)
  /\b(death|fatal|life-threatening|serious injury)\b/i,
  /\b(immediately (stop|cease|discontinue)|do not (use|administer|consume))\b/i,
  /\b(falsified|counterfeit|contaminat)/i,
  /\burgent (field safety|recall|action)\b/i,
];

const HIGH_PATTERNS = [
  /\bclass\s*ii\b(?!\s*i)/i,
  /\b(safety (alert|communication|advisory)|serious (risk|adverse)|black box|boxed warning)\b/i,
  /\b(recall|withdraw)/i,
  /\b(outbreak|infection risk)\b/i,
];

const MEDIUM_PATTERNS = [
  /\bclass\s*iii\b/i,
  /\b(approv|authoris|authoriz|clearance|guidance|guideline|shortage)/i,
];

export function classify({ title = '', summary = '', openFdaClassification = null }) {
  const haystack = `${title} ${summary}`;

  let category = 'Other';
  for (const [name, pattern] of CATEGORY_RULES) {
    if (pattern.test(haystack)) {
      category = name;
      break;
    }
  }

  let severity = severityFor(haystack, category);

  // An openFDA record carries the authority's own recall classification, which
  // is authoritative and overrides the keyword guess.
  if (openFdaClassification) {
    const klass = String(openFdaClassification).toUpperCase();
    if (klass.includes('CLASS I') && !klass.includes('CLASS II') && !klass.includes('CLASS III')) {
      severity = 'critical';
    } else if (klass.includes('CLASS II') && !klass.includes('CLASS III')) {
      severity = 'high';
    } else if (klass.includes('CLASS III')) {
      severity = 'medium';
    }
    category = 'Recall';
  }

  return { category, severity };
}

function severityFor(haystack, category) {
  if (CRITICAL_PATTERNS.some((p) => p.test(haystack))) return 'critical';
  if (HIGH_PATTERNS.some((p) => p.test(haystack))) return 'high';
  if (MEDIUM_PATTERNS.some((p) => p.test(haystack))) return 'medium';
  if (category === 'Safety Alert' || category === 'Enforcement') return 'high';
  return 'info';
}
