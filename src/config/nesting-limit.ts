/**
 * Nesting depth limits for config JSON to prevent stack overflow.
 *
 * This module provides guards that reject deeply-nested JSON structures before
 * they can cause native stack overflow during parsing or recursive traversal.
 *
 * @see MAX_CONFIG_JSON_NESTING_DEPTH - Maximum allowed nesting depth (512 levels)
 * @see ConfigNestingDepthError - Error thrown when depth limit is exceeded
 */

import { MAX_CONFIG_JSON_NESTING_DEPTH, ConfigNestingDepthError } from "./env-substitution.js";

/**
 * Line terminators that end a JSON5 line comment. JSON5 follows the ECMAScript
 * line-terminator set, so CR, LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR
 * (U+2029) end a comment just like LF.
 */
const LINE_COMMENT_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

/**
 * Scans raw JSON/JSON5 text iteratively to measure maximum nesting depth
 * before parsing, rejecting pathological inputs that would overflow the stack.
 *
 * Uses an iterative counter-based approach (not recursion) to safely handle
 * arbitrarily deep structures. Lexical state is consumed in a single pass:
 * comments are only recognized outside strings (so quotes inside comments can
 * never open a string) and string escapes are consumed as pairs (so `\\` and
 * `\"` keep the string state correct).
 *
 * @param raw - Raw JSON/JSON5 text to scan
 * @param maxDepth - Maximum allowed depth (default: MAX_CONFIG_JSON_NESTING_DEPTH)
 * @returns The measured maximum nesting depth
 * @throws {ConfigNestingDepthError} If depth exceeds maxDepth
 */
export function assertBoundedRawJsonNesting(
  raw: string,
  maxDepth: number = MAX_CONFIG_JSON_NESTING_DEPTH,
): number {
  let currentDepth = 0;
  let maxDepthReached = 0;
  let inString = false;
  let stringChar = "";
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i] ?? "";
    const nextChar = i < raw.length - 1 ? (raw[i + 1] ?? "") : "";

    if (inLineComment) {
      if (LINE_COMMENT_TERMINATORS.has(char)) {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && nextChar === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (char === "\\") {
        // Consume the escaped character so `\\` and `\"` keep parity.
        i++;
        continue;
      }
      if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (char === "/" && nextChar === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === "/" && nextChar === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = true;
      stringChar = char;
      continue;
    }
    if (char === "[" || char === "{") {
      currentDepth++;
      maxDepthReached = Math.max(maxDepthReached, currentDepth);
      if (currentDepth > maxDepth) {
        const line = raw.slice(0, i).split(/[\n\r\u2028\u2029]/).length;
        throw new ConfigNestingDepthError(
          currentDepth,
          `raw JSON at character ${i} (line ${line})`,
        );
      }
      continue;
    }
    if (char === "]" || char === "}") {
      currentDepth = Math.max(0, currentDepth - 1);
    }
  }

  return maxDepthReached;
}

/**
 * Recursively scans a parsed JSON value to measure its structural nesting depth.
 *
 * @param value - Parsed JSON value to scan
 * @param maxDepth - Maximum allowed depth (default: MAX_CONFIG_JSON_NESTING_DEPTH)
 * @param path - Current path for error reporting (internal use)
 * @param currentDepth - Current depth for recursion (internal use)
 * @returns The measured maximum nesting depth
 * @throws {ConfigNestingDepthError} If depth exceeds maxDepth
 */
export function assertBoundedJsonNesting(
  value: unknown,
  maxDepth: number = MAX_CONFIG_JSON_NESTING_DEPTH,
  path = "",
  currentDepth = 0,
): number {
  if (currentDepth > maxDepth) {
    throw new ConfigNestingDepthError(currentDepth, path || "parsed JSON");
  }

  let maxDepthReached = currentDepth;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const childDepth = assertBoundedJsonNesting(
        value[i],
        maxDepth,
        path ? `${path}[${i}]` : `[${i}]`,
        currentDepth + 1,
      );
      maxDepthReached = Math.max(maxDepthReached, childDepth);
    }
  } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, val] of Object.entries(value)) {
      const childDepth = assertBoundedJsonNesting(
        val,
        maxDepth,
        path ? `${path}.${key}` : key,
        currentDepth + 1,
      );
      maxDepthReached = Math.max(maxDepthReached, childDepth);
    }
  }

  return maxDepthReached;
}
