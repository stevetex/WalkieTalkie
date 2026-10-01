// Screen names against a list of offensive words (App Review guideline 1.2: apps with
// user-generated content filter objectionable material). Checked here, not in the apps, so the
// list can change without an app release.
//
// Whole words only, so "Scunthorpe" or "Cassandra" pass: a name is split into words after
// folding accents, case and look-alike digits ("sh1t"), and runs of single letters are joined
// ("s.h.i.t"). A word matches a listed word, or it with a plural "s"/"es"; a listed phrase
// matches the same words in a row; the whole name with its spaces removed matches too, from
// six letters ("shit head"). A few roots are matched inside words as well, since nothing
// innocent contains them. Anything still gets through by report: this is a first line, not
// moderation.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Look-alike characters, folded before splitting into words.
const LOOKALIKES: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };

// Listed words that are also real names: "Dick" is a first name; Butt and Mong are surnames.
// "s&m" would match any name with the initials S M.
const EXCEPTIONS = new Set(["dick", "butt", "mong", "s&m"]);

// Matched inside words too.
const ROOTS = ["fuck", "nigger", "nigga", "faggot"];

function words(text: string): string[] {
  const folded = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => LOOKALIKES[c]);
  return folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// Runs of two or more one-letter words joined into one ("s h i t" → "shit").
function joinLetters(list: string[]): string[] {
  const joined: string[] = [];
  let run = "";
  for (const word of [...list, ""]) {
    if (word.length === 1) {
      run += word;
      continue;
    }
    if (run.length > 1) joined.push(run);
    run = "";
  }
  return joined;
}

interface Blocklist {
  words: Set<string>;
  // Phrases as their words joined by single spaces, padded with a space at each end.
  phrases: string[];
  // Entries with no letters or digits (an emoji), matched anywhere in the name.
  symbols: string[];
}

export function parseBlocklist(text: string): Blocklist {
  const list: Blocklist = { words: new Set(), phrases: [], symbols: [] };
  for (const line of text.split("\n")) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#") || EXCEPTIONS.has(entry.toLowerCase())) continue;
    const parts = words(entry);
    if (parts.length === 0) list.symbols.push(entry);
    else if (parts.length === 1) list.words.add(parts[0]);
    else list.phrases.push(` ${parts.join(" ")} `);
  }
  return list;
}

const blocklist = parseBlocklist(readFileSync(join(import.meta.dirname, "name-blocklist.txt"), "utf8"));

// False if the name contains a listed word or phrase.
export function nameAllowed(name: string, list: Blocklist = blocklist): boolean {
  if (list.symbols.some((symbol) => name.includes(symbol))) return false;
  const parts = words(name);
  const compact = parts.join("");
  if (ROOTS.some((root) => compact.includes(root))) return false;
  // The whole name only when long enough not to be someone's initials ("Ana L").
  const candidates = [...parts, ...joinLetters(parts), ...(compact.length >= 6 ? [compact] : [])];
  for (const word of candidates) {
    if (list.words.has(word)) return false;
    if (word.endsWith("s") && list.words.has(word.slice(0, -1))) return false;
    if (word.endsWith("es") && list.words.has(word.slice(0, -2))) return false;
  }
  const spaced = ` ${parts.join(" ")} `;
  return !list.phrases.some((phrase) => spaced.includes(phrase));
}
