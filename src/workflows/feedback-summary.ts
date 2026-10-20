/**
 * The feedback summary (Task 9, ADR 0028). Pure: no I/O, no clock, no randomness, no model, and no mutation of its input.
 *
 * Counts are per item: a term that appears five times in one feedback text counts once. Ties are broken by term (ascending)
 * for themes and by (createdAt, id) for the sample, so the same rows always give the same summary, whatever order they
 * arrive in. The texts are untrusted data. They are tokenised and counted here and are never interpreted.
 */

export interface FeedbackTextRow {
  id: string;
  text: string;
  createdAt: Date;
}

export interface FeedbackSummary {
  themes: { term: string; count: number }[];
  /** Up to three of the earliest texts, each cut to 140 characters. Returned as data. */
  sample: string[];
  total: number;
}

export const THEME_LIMIT = 10;
export const SAMPLE_LIMIT = 3;
export const SAMPLE_CHARACTERS = 140;
export const MIN_TERM_LENGTH = 3;

/** English function words and contraction stems. A term in this list is never a theme. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "about", "above", "after", "again", "against", "all", "also", "although", "always", "am", "among", "an", "and",
  "any", "are", "around", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but",
  "by", "can", "could", "did", "do", "does", "doing", "done", "down", "during", "each", "either", "else", "even",
  "ever", "every", "few", "for", "from", "further", "get", "gets", "got", "had", "has", "have", "having", "her",
  "here", "hers", "herself", "him", "himself", "his", "how", "however", "its", "itself", "just", "let", "like", "made",
  "make", "many", "may", "might", "more", "most", "much", "must", "neither", "nor", "not", "now", "off", "often", "once",
  "only", "onto", "other", "others", "our", "ours", "ourselves", "out", "over", "own", "per", "quite", "rather", "really",
  "same", "shall", "she", "should", "since", "some", "such", "than", "that", "the", "their", "theirs", "them",
  "themselves", "then", "there", "these", "they", "this", "those", "though", "through", "thus", "too", "under", "until",
  "upon", "very", "was", "wasn", "were", "weren", "what", "when", "where", "whether", "which", "while", "who", "whom",
  "whose", "why", "will", "with", "within", "without", "would", "wouldn", "you", "your", "yours", "yourself",
  "yourselves", "don", "doesn", "didn", "isn", "aren", "won", "couldn", "shouldn", "hasn", "haven", "hadn",
  "ain", "via", "vs", "etc",
]);

/** Letters, combining marks and digits form a term. Anything else separates terms, so an apostrophe splits a word. */
const SEPARATOR = /[^\p{L}\p{M}\p{N}]+/u;

/** The distinct terms of one text, after lowercasing, splitting, dropping short tokens and stop words. */
function termsOf(text: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of text.normalize("NFC").toLowerCase().split(SEPARATOR)) {
    if (raw.length < MIN_TERM_LENGTH) continue;
    if (STOP_WORDS.has(raw)) continue;
    terms.add(raw);
  }
  return terms;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Cuts a text to a number of characters (code points), so a surrogate pair is never split. */
function firstCharacters(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}

export function summarizeTexts(items: FeedbackTextRow[]): FeedbackSummary {
  // Counts are per item: each item contributes at most one to each term.
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const term of termsOf(item.text)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  const themes = [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || compareText(a.term, b.term))
    .slice(0, THEME_LIMIT);

  // A copy, so the caller's array is not reordered.
  const earliest = [...items]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareText(a.id, b.id))
    .slice(0, SAMPLE_LIMIT)
    .map((item) => firstCharacters(item.text, SAMPLE_CHARACTERS));

  return { themes, sample: earliest, total: items.length };
}
